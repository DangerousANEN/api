create table if not exists "public"."round_highlights" (
  "id" uuid primary key default gen_random_uuid(),
  "match_id" uuid not null references "public"."matches" ("id") on delete cascade,
  "match_map_id" uuid null references "public"."match_maps" ("id") on delete set null,
  "round_number" integer not null,
  "steam_id" varchar(32) not null,
  "player_name" varchar(128) null,
  "team" varchar(8) null,
  "kills" integer not null,
  "label" varchar(16) not null,
  "weapon" varchar(32) null,
  "metadata" jsonb null,
  "created_at" timestamptz not null default now()
);

create index if not exists "round_highlights_match_round"
  on "public"."round_highlights" ("match_id", "round_number");
create index if not exists "round_highlights_match_label"
  on "public"."round_highlights" ("match_id", "label");
create index if not exists "round_highlights_steam"
  on "public"."round_highlights" ("steam_id");
