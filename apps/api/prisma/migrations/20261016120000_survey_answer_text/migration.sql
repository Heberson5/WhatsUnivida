-- AlterTable
ALTER TABLE "SatisfactionSurvey" ADD COLUMN     "answerText" TEXT,
ADD COLUMN     "originalScore" INTEGER,
ADD COLUMN     "reaskedAt" TIMESTAMP(3),
ADD COLUMN     "scoreCorrectedAt" TIMESTAMP(3),
ADD COLUMN     "scoreCorrectedById" TEXT;

-- AddForeignKey
ALTER TABLE "SatisfactionSurvey" ADD CONSTRAINT "SatisfactionSurvey_scoreCorrectedById_fkey" FOREIGN KEY ("scoreCorrectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Surveys answered before this column existed: the customer's answer is the first message they sent after the
-- survey went out, kept on the rated conversation.
UPDATE "SatisfactionSurvey" s
SET "answerText" = (
  SELECT m."body" FROM "Message" m
  WHERE m."conversationId" = s."conversationId" AND m."direction" = 'INBOUND' AND m."createdAt" >= s."sentAt"
  ORDER BY m."createdAt" ASC
  LIMIT 1
)
WHERE s."answeredAt" IS NOT NULL;
