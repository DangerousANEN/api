import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
} from "@nestjs/common";
import { HighlightsService } from "./highlights.service";

interface IngestPayload {
  highlights: Array<{
    round: number;
    steam_id: string;
    player_name?: string | null;
    team?: string | null;
    kills: number;
    label: string;
    weapon?: string | null;
    metadata?: unknown;
    match_map_id?: string | null;
  }>;
}

// F3 endpoints. The streamer pod (spec-server.mjs) and the CSSharp
// plugin both POST highlights here as they are detected; the panel
// reads `GET /matches/:matchId/highlights` to render the BLAST-style
// recap timeline next to the live feed.
@Controller("matches/:matchId/highlights")
export class HighlightsController {
  private readonly logger = new Logger(HighlightsController.name);

  constructor(private readonly highlights: HighlightsService) {}

  @Get()
  async list(@Param("matchId") matchId: string) {
    return await this.highlights.listForMatch(matchId);
  }

  // No auth here on purpose: the same endpoint is hit by:
  //   1. spec-server.mjs (in-cluster, runs as the streamer pod)
  //   2. CSSharp plugin on game-server (also in-cluster)
  // Both pods are reachable only from inside the cluster network so
  // this is fine for the tournament use case. Wire an api-key middle-
  // ware later if exposing externally.
  @Post()
  async ingest(
    @Param("matchId") matchId: string,
    @Body() body: IngestPayload,
  ) {
    if (!body || !Array.isArray(body.highlights)) {
      throw new BadRequestException("highlights[] required");
    }
    if (body.highlights.length > 50) {
      throw new BadRequestException("max 50 highlights per request");
    }
    for (const h of body.highlights) {
      if (
        typeof h.round !== "number" ||
        typeof h.steam_id !== "string" ||
        typeof h.kills !== "number" ||
        typeof h.label !== "string"
      ) {
        throw new BadRequestException(
          "each highlight needs round/steam_id/kills/label",
        );
      }
    }
    const result = await this.highlights.ingestHighlights(
      matchId,
      body.highlights,
    );
    this.logger.log(
      `ingested ${result.inserted} highlights for match ${matchId} ` +
        `(labels: ${body.highlights.map((h) => h.label).join(",")})`,
    );
    return result;
  }
}
