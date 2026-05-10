drop trigger if exists "set_public_match_overlay_huds_updated_at"
  on "public"."match_overlay_huds";
drop function if exists "public"."set_current_timestamp_match_overlay_huds_updated_at"();
drop table if exists "public"."match_overlay_huds";
alter table "public"."match_options" drop column if exists "raw_hud_overlay";
