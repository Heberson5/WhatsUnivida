-- AlterEnum
ALTER TYPE "MessageType" ADD VALUE 'POLL';
ALTER TYPE "MessageType" ADD VALUE 'EVENT';

-- AlterTable
ALTER TABLE "MessageAttachment" ADD COLUMN     "pollQuestion" TEXT,
ADD COLUMN     "pollOptions" JSONB,
ADD COLUMN     "eventName" TEXT,
ADD COLUMN     "eventDescription" TEXT,
ADD COLUMN     "eventStartAt" TIMESTAMP(3),
ADD COLUMN     "eventJoinLink" TEXT;
