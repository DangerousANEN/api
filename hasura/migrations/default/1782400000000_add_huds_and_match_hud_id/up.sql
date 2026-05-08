-- HUDs uploaded by organizers; match.hud_id references the HUD to use
-- for the live spectator overlay. NULL means use the global default
-- (huds.is_default = true) OR the OpenHud built-in hud if no default.
create table if not exists "public"."huds" (
  "id" uuid primary key default gen_random_uuid(),
  "name" varchar(128) not null,
  "slug" varchar(64) not null,
  "description" text null,
  "version" varchar(32) null,
  "uploader_steam_id" varchar(32) null,
  "is_default" boolean not null default false,
  "is_public" boolean not null default true,
  "size_bytes" bigint not null default 0,
  "extracted_dir" text not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  unique ("slug")
);

create unique index if not exists "huds_only_one_default"
  on "public"."huds" ((true))
  where "is_default" = true;

create index if not exists "huds_uploader" on "public"."huds" ("uploader_steam_id");

alter table "public"."matches"
  add column if not exists "hud_id" uuid null
  references "public"."huds" ("id") on delete set null;

create index if not exists "matches_hud_id" on "public"."matches" ("hud_id");
