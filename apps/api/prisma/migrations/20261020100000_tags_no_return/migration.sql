-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "closeReason" TEXT,
ADD COLUMN     "noReturnCloseAt" TIMESTAMP(3),
ADD COLUMN     "noReturnHold" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "skipSurvey" BOOLEAN NOT NULL DEFAULT false;

