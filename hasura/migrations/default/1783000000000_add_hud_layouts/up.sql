CREATE TABLE "public"."hud_layouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(128) NOT NULL,
  "slug" varchar(64) NOT NULL UNIQUE,
  "category" varchar(32) NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "is_public" boolean NOT NULL DEFAULT true,
  "created_by_steam_id" varchar(32) NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "public"."match_overlay_huds"
  ADD COLUMN "layout_id" uuid NULL
  REFERENCES "public"."hud_layouts" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "public"."set_current_timestamp_updated_at"()
RETURNS TRIGGER AS $$
DECLARE
  _new record;
BEGIN
  _new := NEW;
  _new."updated_at" := NOW();
  RETURN _new;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "set_public_hud_layouts_updated_at"
BEFORE UPDATE ON "public"."hud_layouts"
FOR EACH ROW
EXECUTE PROCEDURE "public"."set_current_timestamp_updated_at"();
