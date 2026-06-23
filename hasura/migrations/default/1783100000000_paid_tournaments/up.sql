ALTER TABLE "public"."tournaments" ADD COLUMN "is_paid" boolean NOT NULL DEFAULT false;
ALTER TABLE "public"."tournaments" ADD COLUMN "payment_details" text;

CREATE TYPE "public"."e_payment_status" AS ENUM ('none', 'pending', 'paid');
ALTER TABLE "public"."tournament_team_roster" ADD COLUMN "payment_status" "public"."e_payment_status" NOT NULL DEFAULT 'none';
ALTER TABLE "public"."tournament_teams" ADD COLUMN "payment_status" "public"."e_payment_status" NOT NULL DEFAULT 'none';
