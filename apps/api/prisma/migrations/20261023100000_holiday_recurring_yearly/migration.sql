-- AlterTable
ALTER TABLE "Holiday" ADD COLUMN     "monthDay" TEXT,
ADD COLUMN     "recurringYearly" BOOLEAN NOT NULL DEFAULT false;

-- Existing rows: the day and month of their date.
UPDATE "Holiday" SET "monthDay" = to_char("date", 'MM-DD');

-- CreateIndex
CREATE INDEX "Holiday_recurringYearly_monthDay_idx" ON "Holiday"("recurringYearly", "monthDay");
