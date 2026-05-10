-- Update tai_match() so that match organizers / admins / tournament
-- organizers are NOT auto-added to lineup_1 when they create a pickup
-- match (no preset team_id, no lobby). Regular users (`user`,
-- `verified_user`, `streamer`, …) keep the existing behaviour.
--
-- Identical to the previous body except for the role check on the
-- final ELSIF branch — diff isolated for review.

CREATE OR REPLACE FUNCTION public.tai_match()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    _max_players_per_lineup int;
    available_regions text[];
    _lobby_id UUID;
    lobby_players bigint[];
    _tournament_id UUID;

    lineup_1_team_id UUID;
    lineup_2_team_id UUID;

    lineup_1_player_count int;
    lineup_2_player_count int;
    member RECORD;
    i RECORD;
BEGIN
   PERFORM setup_match_maps(NEW.id, NEW.match_options_id);

   IF NOT is_tournament_match(NEW) THEN
       SELECT match_max_players_per_lineup(NEW) INTO _max_players_per_lineup;

       select team_id into lineup_1_team_id from match_lineups where id = NEW.lineup_1_id;
       select team_id into lineup_2_team_id from match_lineups where id = NEW.lineup_2_id;

       IF lineup_1_team_id IS NOT NULL THEN
            FOR member IN
            SELECT tr.player_steam_id
            FROM team_roster tr
            INNER JOIN teams t ON t.id = tr.team_id
            WHERE tr.team_id = lineup_1_team_id
            ORDER BY
                CASE
                    WHEN tr.player_steam_id = t.captain_steam_id THEN 0
                    ELSE 1
                END,
                CASE tr.status
                    WHEN 'Starter' THEN 1
                    WHEN 'Substitute' THEN 2
                    WHEN 'Benched' THEN 3
                    ELSE 4
                END
            LIMIT _max_players_per_lineup
            LOOP
                INSERT INTO match_lineup_players (match_lineup_id, steam_id)
                VALUES (NEW.lineup_1_id, member.player_steam_id);
            END LOOP;
       END IF;

        IF lineup_2_team_id IS NOT NULL THEN
            FOR member IN
            SELECT tr.player_steam_id
            FROM team_roster tr
            INNER JOIN teams t ON t.id = tr.team_id
            WHERE tr.team_id = lineup_2_team_id
            ORDER BY
                CASE
                    WHEN tr.player_steam_id = t.captain_steam_id THEN 0
                    ELSE 1
                END,
                CASE tr.status
                    WHEN 'Starter' THEN 1
                    WHEN 'Substitute' THEN 2
                    WHEN 'Benched' THEN 3
                    ELSE 4
                END
            LIMIT _max_players_per_lineup
            LOOP
                INSERT INTO match_lineup_players (match_lineup_id, steam_id)
                VALUES (NEW.lineup_2_id, member.player_steam_id);
            END LOOP;
       END IF;

        SELECT l.id INTO _lobby_id
            FROM lobbies l
            INNER JOIN lobby_players lp ON lp.lobby_id = l.id
            WHERE
            lp.steam_id = (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-user-id')::bigint
            AND lp.status = 'Accepted';


        IF (_lobby_id IS NOT NULL AND (lineup_1_team_id IS NULL OR lineup_2_team_id IS NULL)) THEN
            SELECT array_agg(lp.steam_id) INTO lobby_players
                FROM lobby_players lp
                WHERE lp.lobby_id = _lobby_id
                AND lp.status = 'Accepted';

            IF lineup_1_team_id IS NOT NULL OR lineup_2_team_id IS NOT NULL THEN
                IF array_length(lobby_players, 1) > _max_players_per_lineup THEN
                    RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Too many players in lobby - maximum ' || (_max_players_per_lineup) || ' players allowed';
                END IF;
            ELSIF array_length(lobby_players, 1) > _max_players_per_lineup * 2 THEN
                RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Too many players in lobby - maximum ' || (_max_players_per_lineup * 2) || ' players allowed';
            END IF;

            FOR i IN
                SELECT steam_id, row_number() OVER () as rn,
                       count(*) OVER () as total
                FROM unnest(lobby_players) as steam_id
            LOOP

                IF lineup_1_team_id IS NULL AND lineup_2_team_id IS NOT NULL THEN
                     INSERT INTO match_lineup_players (match_lineup_id, steam_id)
                    VALUES (NEW.lineup_1_id, i.steam_id);
                    continue;
                END IF;

                IF lineup_2_team_id IS NULL AND lineup_1_team_id IS NOT NULL THEN
                    INSERT INTO match_lineup_players (match_lineup_id, steam_id)
                    VALUES (NEW.lineup_2_id, i.steam_id);
                    continue;
                END IF;

               IF i.rn <= (i.total + 1) / 2 THEN
                INSERT INTO match_lineup_players(match_lineup_id, steam_id)
                VALUES (NEW.lineup_1_id, i.steam_id);
               ELSE
                INSERT INTO match_lineup_players(match_lineup_id, steam_id)
                VALUES (NEW.lineup_2_id, i.steam_id);
               END IF;

            END LOOP;

        ELSIF (
            lineup_1_team_id IS NULL
            AND lineup_2_team_id IS NULL
            AND (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-role')::text NOT IN (
                'admin',
                'administrator',
                'match_organizer',
                'tournament_organizer'
            )
        ) THEN
            INSERT INTO match_lineup_players(match_lineup_id, steam_id)
            VALUES (NEW.lineup_1_id, (current_setting('hasura.user', true)::jsonb ->> 'x-hasura-user-id')::bigint);
        END IF;
   END IF;

    IF is_tournament_match(NEW) THEN
        SELECT ts.tournament_id
        INTO _tournament_id
        FROM tournament_brackets tb
        INNER JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
        WHERE tb.match_id = NEW.id
        LIMIT 1;

        IF _tournament_id IS NOT NULL THEN
            PERFORM calculate_tournament_bracket_start_times(_tournament_id);
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;
