-- AlterTable
ALTER TABLE "MessageAttachment" ADD COLUMN     "isGif" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MessageReaction" ADD COLUMN     "participantJid" TEXT,
ADD COLUMN     "participantName" TEXT,
ADD COLUMN     "participantPhone" TEXT;
