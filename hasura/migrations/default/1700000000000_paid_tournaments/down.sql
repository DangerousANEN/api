ALTER TABLE "public"."tournament_teams" DROP COLUMN "payment_status";
ALTER TABLE "public"."tournament_roster" DROP COLUMN "payment_status";
DROP TYPE "public"."e_payment_status";

ALTER TABLE "public"."tournaments" DROP COLUMN "payment_details";
ALTER TABLE "public"."tournaments" DROP COLUMN "is_paid";
