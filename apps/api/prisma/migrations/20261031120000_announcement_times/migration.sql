-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN "startTime" TEXT, ADD COLUMN "endTime" TEXT;

-- Every pop-up now needs "Li e estou ciente". Notices already over keep their history as it was.
UPDATE "Announcement" SET "requireAck" = true
WHERE "display" = 'POPUP_AND_BOARD'
  AND "deletedAt" IS NULL
  AND COALESCE(CASE WHEN "recurrence" = 'ONCE' THEN "startDate" ELSE "endDate" END, '9999-12-31') >= to_char(now() - interval '4 hours', 'YYYY-MM-DD');
