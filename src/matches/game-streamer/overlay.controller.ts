import { Controller, Get, Logger, Param } from "@nestjs/common";
import { GameStreamerService } from "./game-streamer.service";
import { HasuraService } from "../../hasura/hasura.service";
import { PostgresService } from "../../postgres/postgres.service";

interface OverlayHudSlotRow {
  id: string;
  slot_key: string;
  label: string | null;
  hud_id: string | null;
  display_order: number;
  hud_slug: string | null;
  hud_name: string | null;
  hud_format: string | null;
}

// Public, no-auth surface for OBS Browser Source HUD overlays. The
// operator's OBS pulls a Nuxt page (e.g. /overlay/hud/<matchId>?slot=
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
    private readonly postgres: PostgresService,
  ) {}

  @Get("state/:matchId")
  public async state(@Param("matchId") matchId: string) {
    const [{ matches_by_pk: match }, gsi, slots] = await Promise.all([
      this.hasura.query({
        matches_by_pk: {
          __args: { id: matchId },
          id: true,
          status: true,
          // get_current_match_map() computed column → uuid of the live
          // map row. The Hasura model doesn't expose a relationship
          // named `current_match_map`, so consumers resolve it client
          // -side from match_maps[].id.
          current_match_map_id: true,
          match_options_id: true,
          options: {
            type: true,
            best_of: true,
            raw_hud_overlay: true,
          },
          lineup_1: { id: true, name: true },
          lineup_2: { id: true, name: true },
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
      // Slot list is exposed publicly because OBS Browser Sources
      // hit this endpoint without any session cookie. Slots are just
      // (key, label, hud_id) tuples — the underlying HUD pack itself
      // is served separately and already gated on `huds.is_public` /
      // `is_default` further down the stack.
      this.postgres
        .query<OverlayHudSlotRow[]>(
          `select s.id,
                  s.slot_key,
                  s.label,
                  s.hud_id,
                  s.display_order,
                  h.slug   as hud_slug,
                  h.name   as hud_name,
                  h.format as hud_format
             from public.match_overlay_huds s
             join public.matches m on m.match_options_id = s.match_options_id
             left join public.huds h on h.id = s.hud_id
            where m.id = $1
            order by s.display_order asc, s.slot_key asc`,
          [matchId],
        )
        .catch((error): OverlayHudSlotRow[] => {
          this.logger.warn(
            `[overlay] slot list lookup failed for ${matchId}: ` +
              ((error as Error)?.message ?? String(error)),
          );
          return [];
        }),
    ]);

    if (!match) {
      return {
        match: null,
        gsi: null,
        overlay_huds: [],
      };
    }

    return {
      match,
      gsi: gsi.gsi,
      overlay_huds: slots.map((row) => ({
        id: row.id,
        slot_key: row.slot_key,
        label: row.label,
        hud_id: row.hud_id,
        display_order: row.display_order,
        hud: row.hud_id
          ? {
              id: row.hud_id,
              slug: row.hud_slug,
              name: row.hud_name,
              format: row.hud_format,
            }
          : null,
      })),
    };
  }
}
