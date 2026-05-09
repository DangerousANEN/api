create table if not exists "public"."intros" (
  "id" uuid primary key default gen_random_uuid(),
  "map_name" varchar(32) not null,
  "display_name" varchar(128) null,
  "uploader_steam_id" varchar(32) null,
  "size_bytes" bigint not null default 0,
  "s3_key" text not null,
  "duration_seconds" integer null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  unique ("map_name")
);

create index if not exists "intros_uploader" on "public"."intros" ("uploader_steam_id");
