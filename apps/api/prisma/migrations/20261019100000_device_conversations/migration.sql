-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "startedOnDevice" BOOLEAN NOT NULL DEFAULT false;

-- Conversations already being handled on the phone count as started there.
UPDATE "Conversation" SET "startedOnDevice" = true WHERE "status" = 'HANDLED_EXTERNALLY';

-- AlterTable
ALTER TABLE "WhatsAppConnection" ADD COLUMN     "deviceReplyTimeoutMinutes" INTEGER DEFAULT 5;

