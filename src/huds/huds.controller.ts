import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { HudsService } from "./huds.service";
import { User } from "../auth/types/User";

@Controller("huds")
export class HudsController {
  constructor(private readonly huds: HudsService) {}

  @Get()
  async list(@Req() request: Request) {
    const user = (request.user ?? null) as User | null;
    return await this.huds.listHuds(user);
  }

  @Get("active/:matchId")
  async getActive(@Param("matchId") matchId: string) {
    const hud = await this.huds.getActiveForMatch(matchId);
    if (!hud) throw new NotFoundException("no HUD configured");
    return hud;
  }

  // Returns the *override* HUD bound to matches.hud_id, NOT the effective
  // (which would mix in the global default). Used by MatchHudPicker so the
  // dropdown can distinguish "I picked Lexogrine for this match" from "I
  // inherit the global default". A null body means: no per-match override.
  @Get("match/:matchId")
  async getMatchOverride(@Param("matchId") matchId: string) {
    return { hud: await this.huds.getOverrideForMatch(matchId) };
  }

  @Get(":idOrSlug")
  async get(@Param("idOrSlug") idOrSlug: string) {
    const hud = await this.huds.getHud(idOrSlug);
    if (!hud) throw new NotFoundException("HUD not found");
    return hud;
  }

  // Multipart upload of a HUD zip. Body fields (besides "file"):
  //   name, slug, description?, version?, isPublic? (default true)
  @Post("upload")
  @UseInterceptors(FileInterceptor("file"))
  async upload(
    @Req() request: Request,
    @Body() body: Record<string, string>,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 200 * 1024 * 1024 }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = (request.user ?? null) as User | null;
    if (!user) throw new BadRequestException("not authenticated");

    if (
      !file ||
      !file.mimetype ||
      !/(zip|x-zip|octet-stream)/.test(file.mimetype)
    ) {
      throw new BadRequestException("file must be a zip");
    }

    const name = (body.name ?? "").trim();
    const slug = (body.slug ?? "").trim().toLowerCase();
    if (!name || !slug) {
      throw new BadRequestException("name and slug required");
    }
    const description = body.description?.trim() || null;
    const version = body.version?.trim() || null;
    const isPublic = body.isPublic !== "false";

    return await this.huds.uploadHud(
      user,
      name,
      slug,
      description,
      version,
      isPublic,
      file.buffer,
    );
  }

  @Delete(":idOrSlug")
  async remove(
    @Req() request: Request,
    @Param("idOrSlug") idOrSlug: string,
  ) {
    const user = (request.user ?? null) as User | null;
    if (!user) throw new BadRequestException("not authenticated");
    await this.huds.deleteHud(user, idOrSlug);
    return { success: true };
  }

  @Post(":idOrSlug/set-default")
  async setDefault(
    @Req() request: Request,
    @Param("idOrSlug") idOrSlug: string,
  ) {
    const user = (request.user ?? null) as User | null;
    if (!user) throw new BadRequestException("not authenticated");
    return await this.huds.setDefault(user, idOrSlug);
  }

  @Post("clear-default")
  async clearDefault(@Req() request: Request) {
    const user = (request.user ?? null) as User | null;
    if (!user) throw new BadRequestException("not authenticated");
    await this.huds.clearDefault(user);
    return { success: true };
  }

  @Post("match/:matchId")
  async setForMatch(
    @Req() request: Request,
    @Param("matchId") matchId: string,
    @Body() body: { hud?: string | null },
  ) {
    const user = (request.user ?? null) as User | null;
    if (!user) throw new BadRequestException("not authenticated");
    await this.huds.setForMatch(user, matchId, body.hud ?? null);
    return { success: true };
  }

  // Public manifest the streamer pod walks to mirror a HUD locally.
  @Get(":slug/manifest")
  async manifest(@Param("slug") slug: string) {
    const m = await this.huds.getManifest(slug);
    if (!m) throw new NotFoundException("manifest not found");
    return m;
  }

  // Public, no-auth endpoint used by both the spectator pod and OBS browser
  // sources. Returns the static HUD file contents.
  @Get(":slug/files/*")
  async file(
    @Param("slug") slug: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    // Express captures the wildcard portion under request.params[0].
    const rel = (request.params as Record<string, string>)[0] ?? "";
    if (!rel) {
      response.status(400).send("missing path");
      return;
    }
    const file = await this.huds.getFile(slug, rel);
    if (!file) {
      response.status(404).send("not found");
      return;
    }
    response.setHeader("content-type", file.contentType);
    if (file.size != null) {
      response.setHeader("content-length", String(file.size));
    }
    response.setHeader("cache-control", "public, max-age=300");
    file.stream.pipe(response);
  }
}
