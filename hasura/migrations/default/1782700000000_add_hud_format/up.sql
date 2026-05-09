-- Track upload format so the panel + streamer pod know which loader
-- pipeline to drive. Existing rows are pre-1782700000000 OpenHud
-- uploads; default them accordingly.
alter table "public"."huds"
  add column if not exists "format" varchar(32) not null default 'openhud';

create index if not exists "huds_format" on "public"."huds" ("format");
