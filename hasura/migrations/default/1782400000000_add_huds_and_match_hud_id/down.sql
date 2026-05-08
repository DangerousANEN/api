alter table "public"."matches" drop column if exists "hud_id";
drop index if exists "public"."huds_only_one_default";
drop table if exists "public"."huds";
