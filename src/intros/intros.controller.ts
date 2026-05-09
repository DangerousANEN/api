import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
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
import { IntrosService } from "./intros.service";
import { User } from "../auth/types/User";

@Controller("intros")
export class IntrosController {
  constructor(private readonly intros: IntrosService) {}

  @Get()
  async list() {
    return await this.intros.listIntros();
  }

  @Get("known-maps")
  async knownMaps() {
    return { maps: this.intros.knownMaps() };
  }

  @Get("map/:mapName")
  async getByMap(@Param("mapName") mapName: string) {
    const intro = await this.intros.getByMap(mapName);
    if (!intro) throw new NotFoundException("no intro for map");
    return intro;
  }

  // Multipart upload of a flythrough mp4. Body fields (besides "file"):
  //   map_name, display_name?, duration_seconds?
  @Post("upload")
  @UseInterceptors(FileInterceptor("file"))
  async upload(
    @Req() request: Request,
    @Body() body: Record<string, string>,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 256 * 1024 * 1024 }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = (request.user ?? null) as User | null;
    if (!user) throw new BadRequestException("not authenticated");
    if (!file) throw new BadRequestException("file required");

    const mapName = (body.map_name ?? "").trim().toLowerCase();
    if (!mapName) throw new BadRequestException("map_name required");

    const displayName = body.display_name?.trim() || null;
    const durationStr = body.duration_seconds?.trim();
    const durationSeconds =
      durationStr && /^\d+$/.test(durationStr) ? parseInt(durationStr, 10) : null;

    return await this.intros.uploadIntro(
      user,
      mapName,
      displayName,
      durationSeconds,
      file.buffer,
      file.mimetype || "application/octet-stream",
    );
  }

  @Delete("map/:mapName")
  async remove(
    @Req() request: Request,
    @Param("mapName") mapName: string,
  ) {
    const user = (request.user ?? null) as User | null;
    if (!user) throw new BadRequestException("not authenticated");
    await this.intros.deleteIntro(user, mapName);
    return { success: true };
  }

  // Public, no-auth endpoint used by the streamer pod (flythrough.sh)
  // and by browser previews on the settings page.
  @Get("map/:mapName/file")
  async file(
    @Param("mapName") mapName: string,
    @Res() response: Response,
  ) {
    const file = await this.intros.getFileByMap(mapName);
    if (!file) {
      response.status(404).send("not found");
      return;
    }
    response.setHeader("content-type", file.contentType);
    if (file.size != null) {
      response.setHeader("content-length", String(file.size));
    }
    response.setHeader("accept-ranges", "bytes");
    response.setHeader("cache-control", "public, max-age=300");
    file.stream.pipe(response);
  }
}
