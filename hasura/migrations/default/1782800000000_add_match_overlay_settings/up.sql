-- Per-match streaming overlay knobs for the OBS Browser Source flow.
--
--   match_options.raw_hud_overlay -> when true, the streamer pod is
--     started with OPENHUD_DISABLED=1 so the in-game overlay is
--     suppressed and OBS composes the HUD from web-served layouts on
--     top of the raw video.
--
--   match_overlay_huds -> per-match list of scenes (game / operator /
--     anything custom the operator wants). Each entry binds a named
--     slot (the OBS scene key) to a HUD package and gives it a
--     human-friendly label + display order. The web page at
--     /overlay/hud/<matchId>?slot=<slot_key> looks up the HUD by
--     (match_options_id, slot_key) and renders that pack.
alter table "public"."match_options"
  add column if not exists "raw_hud_overlay" boolean not null default false;

create table if not exists "public"."match_overlay_huds" (
  "id" uuid primary key default gen_random_uuid(),
  "match_options_id" uuid not null,
  "slot_key" varchar(64) not null,
  "label" text,
  "hud_id" uuid,
  "display_order" integer not null default 0,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "match_overlay_huds_match_options_id_fkey"
    foreign key ("match_options_id") references "public"."match_options" ("id")
    on update cascade on delete cascade,
  constraint "match_overlay_huds_hud_id_fkey"
    foreign key ("hud_id") references "public"."huds" ("id")
    on update cascade on delete set null,
  constraint "match_overlay_huds_match_options_slot_unique"
    unique ("match_options_id", "slot_key")
);

create index if not exists "match_overlay_huds_match_options_id"
  on "public"."match_overlay_huds" ("match_options_id");
create index if not exists "match_overlay_huds_hud_id"
  on "public"."match_overlay_huds" ("hud_id");

create or replace function "public"."set_current_timestamp_match_overlay_huds_updated_at"()
returns trigger as $$
declare
  _new record;
begin
  _new := new;
  _new."updated_at" := now();
  return _new;
end;
$$ language plpgsql;

drop trigger if exists "set_public_match_overlay_huds_updated_at"
  on "public"."match_overlay_huds";
create trigger "set_public_match_overlay_huds_updated_at"
  before update on "public"."match_overlay_huds"
  for each row execute procedure "public"."set_current_timestamp_match_overlay_huds_updated_at"();
