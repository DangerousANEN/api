import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { Readable, PassThrough } from "stream";
import * as unzipper from "unzipper";
import { S3Service } from "../s3/s3.service";
import { HasuraService } from "../hasura/hasura.service";
import { User } from "../auth/types/User";

const HUD_PREFIX = "huds";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 4000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME_BY_EXT[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

export type HudFormat = "openhud" | "lexogrine";

export interface HudRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  version: string | null;
  format: HudFormat;
  uploader_steam_id: string | null;
  is_default: boolean;
  is_public: boolean;
  size_bytes: number;
  extracted_dir: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class HudsService {
  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
  ) {}

  // List all HUDs visible to the caller. Admins see private uploads; others
  // only public ones.
  async listHuds(user: User | null): Promise<HudRow[]> {
    const includePrivate = user?.role === "administrator";
    const { huds } = await this.hasura.query({
      huds: {
        __args: {
          where: includePrivate ? {} : { is_public: { _eq: true } },
          order_by: [{ created_at: "desc" }],
        },
        ...this.hudFields(),
      },
    });
    return (huds ?? []) as HudRow[];
  }

  async getHud(idOrSlug: string): Promise<HudRow | null> {
    const where =
      idOrSlug.includes("-") && idOrSlug.length === 36
        ? { id: { _eq: idOrSlug } }
        : { slug: { _eq: idOrSlug } };
    const { huds } = await this.hasura.query({
      huds: {
        __args: { where, limit: 1 },
        ...this.hudFields(),
      },
    });
    return ((huds ?? [])[0] ?? null) as HudRow | null;
  }

  // Returns ONLY the per-match override (matches.hud_id → HudRow) without
  // falling through to the global default. Used by MatchHudPicker so the
  // UI can distinguish an explicit pick from an inherited default.
  async getOverrideForMatch(matchId: string): Promise<HudRow | null> {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        hud_id: true,
      },
    });
    if (!matches_by_pk?.hud_id) return null;
    return await this.getHud(matches_by_pk.hud_id as string);
  }

  // Resolves the effective HUD for a match: per-match override → global
  // default → null. The streamer pod calls this on launch.
  async getActiveForMatch(matchId: string): Promise<HudRow | null> {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        hud_id: true,
      },
    });
    if (matches_by_pk?.hud_id) {
      const hud = await this.getHud(matches_by_pk.hud_id as string);
      if (hud) return hud;
    }
    const { huds } = await this.hasura.query({
      huds: {
        __args: { where: { is_default: { _eq: true } }, limit: 1 },
        ...this.hudFields(),
      },
    });
    return ((huds ?? [])[0] ?? null) as HudRow | null;
  }

  // Streams a zip into S3 keyed by huds/<slug>/<rel>; rejects path
  // traversal and oversized entries before extraction completes.
  async uploadHud(
    user: User,
    name: string,
    slug: string,
    description: string | null,
    version: string | null,
    isPublic: boolean,
    zipBuffer: Buffer,
  ): Promise<HudRow> {
    if (user.role !== "administrator" && user.role !== "match_organizer") {
      throw new ForbiddenException("Only organizers can upload HUDs");
    }
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException(
        "slug must be 2-64 lowercase a-z0-9 with internal dashes",
      );
    }

    const existing = await this.getHud(slug);
    if (existing) {
      throw new BadRequestException(`HUD with slug "${slug}" already exists`);
    }

    const directory = await unzipper.Open.buffer(zipBuffer);
    if (directory.files.length > MAX_ENTRIES) {
      throw new BadRequestException(
        `zip has ${directory.files.length} entries (limit ${MAX_ENTRIES})`,
      );
    }

    // Pre-scan to (a) sanity-check entry sizes/paths and (b) detect
    // which HUD format the zip ships in. Two formats supported:
    //   - openhud   : <hudname>/build/index.html (file-tree wrapped
    //                 under "build/", electron-loaded by the streamer
    //                 pod's OpenHud overlay)
    //   - lexogrine : root index.html + root package.json (Lexogrine
    //                 HUD Manager pack — designed for OBS Browser
    //                 Source). We accept these for the OBS-overlay
    //                 flow; the streamer pod's OpenHud loader
    //                 won't render Lexogrine packs (they need a
    //                 socket.io GSI bridge, see TODO below).
    let totalBytes = 0;
    let openHudBuildRoot: string | null = null;
    let lexogrineHasIndex = false;
    let lexogrinePackageJsonPath: string | null = null;
    for (const file of directory.files) {
      if (file.type !== "File") continue;
      const path = file.path.replace(/^\/+/, "");
      if (path.includes("..")) {
        throw new BadRequestException(`zip entry "${path}" escapes root`);
      }
      if (file.uncompressedSize > MAX_FILE_BYTES) {
        throw new BadRequestException(
          `zip entry "${path}" is ${file.uncompressedSize}b > ${MAX_FILE_BYTES}b`,
        );
      }
      totalBytes += file.uncompressedSize;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new BadRequestException(
          `zip total ${totalBytes}b > ${MAX_TOTAL_BYTES}b`,
        );
      }
      // OpenHud HUD packs are wrapped in <hudname>/build/. Detect the
      // first build/index.html and treat its parent as the root.
      if (
        openHudBuildRoot === null &&
        (path.endsWith("/build/index.html") || path === "build/index.html")
      ) {
        openHudBuildRoot = path.slice(0, -"index.html".length);
      }
      // Lexogrine HUD packs land flat: index.html + package.json at
      // root (or sometimes wrapped one level — Lexogrine HUD Manager
      // exports as `<slug>/index.html` + `<slug>/package.json`).
      if (path === "index.html" || /^[^/]+\/index\.html$/.test(path)) {
        lexogrineHasIndex = true;
      }
      if (path === "package.json" || /^[^/]+\/package\.json$/.test(path)) {
        lexogrinePackageJsonPath = path;
      }
    }

    let format: HudFormat;
    let buildRoot: string;
    if (openHudBuildRoot) {
      format = "openhud";
      buildRoot = openHudBuildRoot;
    } else if (lexogrineHasIndex && lexogrinePackageJsonPath) {
      format = "lexogrine";
      // Lexogrine packs may or may not be wrapped one level. Take the
      // dirname of package.json as the build root.
      const slash = lexogrinePackageJsonPath.lastIndexOf("/");
      buildRoot = slash === -1 ? "" : lexogrinePackageJsonPath.slice(0, slash + 1);
    } else {
      throw new BadRequestException(
        "zip must be an OpenHud pack (build/index.html) or a Lexogrine pack (index.html + package.json)",
      );
    }

    this.logger.log(
      `extracting HUD "${slug}" format=${format} buildRoot="${buildRoot}" entries=${directory.files.length} bytes=${totalBytes}`,
    );

    const extractedDir = `${HUD_PREFIX}/${slug}/`;
    const manifest: { files: { path: string; size: number }[] } = { files: [] };
    for (const file of directory.files) {
      if (file.type !== "File") continue;
      const raw = file.path.replace(/^\/+/, "");
      if (buildRoot && !raw.startsWith(buildRoot)) continue;
      const rel = buildRoot ? raw.slice(buildRoot.length) : raw;
      if (!rel) continue;
      const buf = await file.buffer();
      await this.s3.put(`${extractedDir}${rel}`, buf);
      manifest.files.push({ path: rel, size: buf.length });
    }
    // Save a manifest the streamer pod / OBS Browser Source can walk
    // to mirror the HUD.
    await this.s3.put(
      `${extractedDir}.manifest.json`,
      Buffer.from(JSON.stringify({ format, files: manifest.files })),
    );

    const id = crypto.randomUUID();
    await this.hasura.mutation({
      insert_huds_one: {
        __args: {
          object: {
            id,
            name,
            slug,
            description,
            version,
            format,
            uploader_steam_id: user.steam_id,
            is_default: false,
            is_public: isPublic,
            size_bytes: totalBytes,
            extracted_dir: extractedDir,
          },
        },
        id: true,
      },
    });

    this.logger.log(`HUD "${slug}" uploaded by ${user.steam_id}`);
    return (await this.getHud(slug))!;
  }

  // Best-effort delete. We delete the row first so it disappears from the
  // panel immediately; orphaned S3 objects can be reaped later by a janitor
  // (the minio client'\''s listObjects supports prefix-recursive listing,
  // but we keep the call site small here).
  async deleteHud(user: User, idOrSlug: string): Promise<void> {
    if (user.role !== "administrator") {
      throw new ForbiddenException("Only administrators can delete HUDs");
    }
    const hud = await this.getHud(idOrSlug);
    if (!hud) throw new NotFoundException("HUD not found");

    await this.hasura.mutation({
      delete_huds_by_pk: {
        __args: { id: hud.id },
        id: true,
      },
    });
    this.logger.log(`HUD "${hud.slug}" row removed by ${user.steam_id}`);
  }

  async setDefault(user: User, idOrSlug: string): Promise<HudRow> {
    if (user.role !== "administrator") {
      throw new ForbiddenException(
        "Only administrators can set the default HUD",
      );
    }
    const hud = await this.getHud(idOrSlug);
    if (!hud) throw new NotFoundException("HUD not found");

    await this.hasura.mutation({
      update_huds: {
        __args: {
          where: { is_default: { _eq: true } },
          _set: { is_default: false },
        },
        affected_rows: true,
      },
    });
    await this.hasura.mutation({
      update_huds_by_pk: {
        __args: {
          pk_columns: { id: hud.id },
          _set: { is_default: true },
        },
        id: true,
      },
    });
    return (await this.getHud(hud.slug))!;
  }

  async clearDefault(user: User): Promise<void> {
    if (user.role !== "administrator") {
      throw new ForbiddenException(
        "Only administrators can clear the default HUD",
      );
    }
    await this.hasura.mutation({
      update_huds: {
        __args: {
          where: { is_default: { _eq: true } },
          _set: { is_default: false },
        },
        affected_rows: true,
      },
    });
  }

  async setForMatch(
    user: User,
    matchId: string,
    idOrSlug: string | null,
  ): Promise<void> {
    if (user.role !== "administrator" && user.role !== "match_organizer") {
      throw new ForbiddenException("Only organizers can set the match HUD");
    }
    let hudId: string | null = null;
    if (idOrSlug) {
      const hud = await this.getHud(idOrSlug);
      if (!hud) throw new NotFoundException("HUD not found");
      hudId = hud.id;
    }
    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: { id: matchId },
          _set: { hud_id: hudId },
        },
        id: true,
      },
    });
  }

  // Returns the manifest of files for a HUD (the streamer pod walks
  // this to mirror the HUD'\''s files into its local OpenHud-Huds dir).
  async getManifest(
    slug: string,
  ): Promise<{ files: { path: string; size: number }[] } | null> {
    const hud = await this.getHud(slug);
    if (!hud) return null;
    let stream: Readable;
    try {
      stream = await this.s3.get(`${hud.extracted_dir}.manifest.json`);
    } catch {
      return null;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        files: { path: string; size: number }[];
      };
    } catch {
      return null;
    }
  }

  // Streams a single file out of the HUD'\''s S3 extracted dir. Returns
  // null on miss so the controller can 404 instead of error.
  async getFile(
    slug: string,
    relPath: string,
  ): Promise<{
    stream: Readable;
    size: number | null;
    contentType: string;
  } | null> {
    const hud = await this.getHud(slug);
    if (!hud) return null;
    const safe = relPath.replace(/^\/+/, "");
    if (!safe || safe.includes("..")) return null;
    const key = `${hud.extracted_dir}${safe}`;
    let size: number | null = null;
    try {
      const stat = await this.s3.stat(key);
      size = stat?.size ?? null;
    } catch {
      return null;
    }
    let stream: Readable;
    try {
      stream = await this.s3.get(key);
    } catch {
      return null;
    }
    const out = new PassThrough();
    stream.pipe(out);
    return { stream: out, size, contentType: mimeFor(safe) };
  }

  private hudFields() {
    return {
      id: true,
      name: true,
      slug: true,
      description: true,
      version: true,
      format: true,
      uploader_steam_id: true,
      is_default: true,
      is_public: true,
      size_bytes: true,
      extracted_dir: true,
      created_at: true,
      updated_at: true,
    };
  }
}
