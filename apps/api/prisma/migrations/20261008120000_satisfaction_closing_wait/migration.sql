-- AlterTable
ALTER TABLE "SatisfactionSurvey" ADD COLUMN     "closingDueAt" TIMESTAMP(3),
ADD COLUMN     "closingOutcome" TEXT,
ADD COLUMN     "closingResolvedAt" TIMESTAMP(3),
ADD COLUMN     "closingSenderId" TEXT,
ADD COLUMN     "closingSenderName" TEXT,
ADD COLUMN     "closingText" TEXT;

-- CreateIndex
CREATE INDEX "SatisfactionSurvey_closingDueAt_idx" ON "SatisfactionSurvey"("closingDueAt");
