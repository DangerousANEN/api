import { Controller, Get, Logger, Param } from "@nestjs/common";
import { GameStreamerService } from "./game-streamer.service";
import { HasuraService } from "../../hasura/hasura.service";

// Public, no-auth surface for OBS Browser Source HUD overlays. The
// operator's OBS pulls a Nuxt page (e.g. /overlay/hud/<matchId>?layout=
// game) which, in turn, polls this endpoint every 1 s for fresh GSI
// state from the streamer pod plus a small slice of match metadata.
//
// Why no auth: OBS Browser Source can't carry session cookies / SSO,
// and adding a per-overlay token UX complicates copy-paste-into-OBS
// for tournament operators. The data exposed here (live scores, names,
// money, equipment) is also rendered into the public HLS feed anyway,
// so leaking it via this endpoint costs nothing extra.
//
// `matchId` is a UUID that already appears in URL paths (HLS, demo
// downloads), so treating it as a capability is consistent with the
// rest of the panel.
@Controller("overlay")
export class OverlayController {
  constructor(
    private readonly logger: Logger,
    private readonly gameStreamer: GameStreamerService,
    private readonly hasura: HasuraService,
  ) {}

  @Get("state/:matchId")
  public async state(@Param("matchId") matchId: string) {
    const [{ matches_by_pk: match }, gsi] = await Promise.all([
      this.hasura.query({
        matches_by_pk: {
          __args: { id: matchId },
          id: true,
          status: true,
          options: { type: true, best_of: true },
          lineup_1: { id: true, name: true },
          lineup_2: { id: true, name: true },
          current_match_map: {
            id: true,
            map: { name: true },
            order: true,
            status: true,
          },
          match_maps: {
            __args: {
              order_by: [{ order: "asc" }],
            },
            id: true,
            order: true,
            status: true,
            map: { name: true },
            lineup_1_score: true,
            lineup_2_score: true,
          },
        },
      }),
      this.gameStreamer
        .getLiveSpecState(matchId)
        .catch((error): { gsi: null } => {
          this.logger.warn(
            `[overlay] getLiveSpecState failed for ${matchId}: ` +
              ((error as Error)?.message ?? String(error)),
          );
          return { gsi: null };
        }),
    ]);

    if (!match) {
      return {
        match: null,
        gsi: null,
      };
    }

    return {
      match,
      gsi: gsi.gsi,
    };
  }
}
