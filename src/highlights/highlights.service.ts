import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";

// F3: round highlight ingestion + retrieval.
//
// The streamer pod's spec-server.mjs detects multi-kill rounds from
// GSI deltas and POSTs them here at round_phase live→over. We dedupe
// by (match_id, round_number, steam_id, label) so re-fires from a
// reconnected GSI handler don't double-insert.
//
// CSSharp plugin (game-server fork) is the source of richer events
// (knife / grenade / no-scope / wallbang / airshot / clutch). It hits
// the same endpoint with `weapon` populated; spec-server-only events
// land without `weapon`.
@Injectable()
export class HighlightsService {
  private readonly logger = new Logger(HighlightsService.name);

  constructor(private readonly hasura: HasuraService) {}

  async ingestHighlights(
    matchId: string,
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
    }>,
  ): Promise<{ inserted: number }> {
    if (highlights.length === 0) return { inserted: 0 };

    let matchMapId: string | null = null;
    try {
      const { matches_by_pk } = await this.hasura.query({
        matches_by_pk: {
          __args: { id: matchId },
          current_match_map_id: true,
        },
      });
      matchMapId = (matches_by_pk?.current_match_map_id as string) ?? null;
    } catch (e) {
      this.logger.warn(
        `failed to resolve current_match_map_id for ${matchId}: ${(e as Error).message}`,
      );
    }

    const objects = highlights.map((h) => ({
      match_id: matchId,
      match_map_id: h.match_map_id ?? matchMapId,
      round_number: h.round,
      steam_id: h.steam_id,
      player_name: h.player_name ?? null,
      team: h.team ?? null,
      kills: h.kills,
      label: h.label,
      weapon: h.weapon ?? null,
      metadata: h.metadata ?? null,
    }));

    const { insert_round_highlights } = await this.hasura.mutation({
      insert_round_highlights: {
        __args: {
          objects,
          on_conflict: undefined,
        },
        affected_rows: true,
      },
    });

    return { inserted: insert_round_highlights?.affected_rows ?? 0 };
  }

  async listForMatch(matchId: string) {
    const { round_highlights } = await this.hasura.query({
      round_highlights: {
        __args: {
          where: { match_id: { _eq: matchId } },
          order_by: [
            { round_number: () => "desc" },
            { kills: () => "desc" },
          ],
        },
        id: true,
        match_id: true,
        match_map_id: true,
        round_number: true,
        steam_id: true,
        player_name: true,
        team: true,
        kills: true,
        label: true,
        weapon: true,
        created_at: true,
      },
    });
    return round_highlights ?? [];
  }
}
