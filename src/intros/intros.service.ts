import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { Readable, PassThrough } from "stream";
import { S3Service } from "../s3/s3.service";
import { HasuraService } from "../hasura/hasura.service";
import { User } from "../auth/types/User";

const INTRO_PREFIX = "intros";
const MAX_INTRO_BYTES = 256 * 1024 * 1024;
// Active duty + a couple legacy/community pool maps. We don't actually
// reject other names — it's just the dropdown the panel populates from.
// The streamer pod looks up by exact map name (de_inferno, de_mirage,
// etc.) so any spelling cs2 emits in GSI can be served.
const KNOWN_MAPS = [
  "de_mirage",
  "de_inferno",
  "de_nuke",
  "de_vertigo",
  "de_ancient",
  "de_anubis",
  "de_dust2",
  "de_overpass",
  "de_train",
  "de_cache",
];
const MAP_RE = /^[a-z0-9_]{2,32}$/;

export interface IntroRow {
  id: string;
  map_name: string;
  display_name: string | null;
  uploader_steam_id: string | null;
  size_bytes: number;
  s3_key: string;
  duration_seconds: number | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class IntrosService {
  constructor(
    private readonly logger: Logger,
    private readonly s3: S3Service,
    private readonly hasura: HasuraService,
  ) {}

  knownMaps(): string[] {
    return [...KNOWN_MAPS];
  }

  async listIntros(): Promise<IntroRow[]> {
    const { intros } = await this.hasura.query({
      intros: {
        __args: { order_by: [{ map_name: "asc" }] },
        ...this.introFields(),
      },
    });
    return (intros ?? []) as IntroRow[];
  }

  async getByMap(mapName: string): Promise<IntroRow | null> {
    const { intros } = await this.hasura.query({
      intros: {
        __args: { where: { map_name: { _eq: mapName } }, limit: 1 },
        ...this.introFields(),
      },
    });
    return ((intros ?? [])[0] ?? null) as IntroRow | null;
  }

  // Streams a single mp4 into S3 keyed by intros/<map_name>.mp4. Replaces
  // any prior binding for the map (one intro per map).
  async uploadIntro(
    user: User,
    mapName: string,
    displayName: string | null,
    durationSeconds: number | null,
    fileBuffer: Buffer,
    contentType: string,
  ): Promise<IntroRow> {
    if (user.role !== "administrator" && user.role !== "match_organizer") {
      throw new ForbiddenException("Only organizers can upload flythroughs");
    }
    if (!MAP_RE.test(mapName)) {
      throw new BadRequestException(
        "map_name must be 2-32 lowercase a-z0-9_ (e.g. de_inferno)",
      );
    }
    if (fileBuffer.length === 0) {
      throw new BadRequestException("empty file");
    }
    if (fileBuffer.length > MAX_INTRO_BYTES) {
      throw new BadRequestException(
        `file is ${fileBuffer.length}b > ${MAX_INTRO_BYTES}b`,
      );
    }

    // Accept mp4 / webm. mpv handles either; we just don't want random
    // .exe / .zip uploads slipping through.
    if (
      !contentType.startsWith("video/") &&
      contentType !== "application/octet-stream"
    ) {
      throw new BadRequestException(
        `content-type ${contentType} not allowed (need video/mp4 or video/webm)`,
      );
    }

    const s3Key = `${INTRO_PREFIX}/${mapName}.mp4`;
    await this.s3.put(s3Key, fileBuffer);

    const existing = await this.getByMap(mapName);
    if (existing) {
      await this.hasura.mutation({
        update_intros_by_pk: {
          __args: {
            pk_columns: { id: existing.id },
            _set: {
              display_name: displayName,
              uploader_steam_id: user.steam_id,
              size_bytes: fileBuffer.length,
              s3_key: s3Key,
              duration_seconds: durationSeconds,
            },
          },
          id: true,
        },
      });
      this.logger.log(
        `intro for ${mapName} replaced by ${user.steam_id} (${fileBuffer.length}b)`,
      );
    } else {
      const id = crypto.randomUUID();
      await this.hasura.mutation({
        insert_intros_one: {
          __args: {
            object: {
              id,
              map_name: mapName,
              display_name: displayName,
              uploader_steam_id: user.steam_id,
              size_bytes: fileBuffer.length,
              s3_key: s3Key,
              duration_seconds: durationSeconds,
            },
          },
          id: true,
        },
      });
      this.logger.log(
        `intro for ${mapName} uploaded by ${user.steam_id} (${fileBuffer.length}b)`,
      );
    }
    return (await this.getByMap(mapName))!;
  }

  async deleteIntro(user: User, mapName: string): Promise<void> {
    if (user.role !== "administrator" && user.role !== "match_organizer") {
      throw new ForbiddenException("Only organizers can delete flythroughs");
    }
    const intro = await this.getByMap(mapName);
    if (!intro) throw new NotFoundException("intro not found");
    await this.hasura.mutation({
      delete_intros_by_pk: {
        __args: { id: intro.id },
        id: true,
      },
    });
    this.logger.log(`intro for ${mapName} row removed by ${user.steam_id}`);
  }

  // Streams the mp4 out of S3 for the streamer pod / browser preview.
  async getFileByMap(mapName: string): Promise<{
    stream: Readable;
    size: number | null;
    contentType: string;
  } | null> {
    const intro = await this.getByMap(mapName);
    if (!intro) return null;
    let size: number | null = null;
    try {
      const stat = await this.s3.stat(intro.s3_key);
      size = stat?.size ?? intro.size_bytes ?? null;
    } catch {
      return null;
    }
    let stream: Readable;
    try {
      stream = await this.s3.get(intro.s3_key);
    } catch {
      return null;
    }
    const out = new PassThrough();
    stream.pipe(out);
    return { stream: out, size, contentType: "video/mp4" };
  }

  private introFields() {
    return {
      id: true,
      map_name: true,
      display_name: true,
      uploader_steam_id: true,
      size_bytes: true,
      s3_key: true,
      duration_seconds: true,
      created_at: true,
      updated_at: true,
    };
  }
}
