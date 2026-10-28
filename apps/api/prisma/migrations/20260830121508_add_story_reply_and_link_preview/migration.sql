-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "isStoryReply" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "linkPreviewDescription" TEXT,
ADD COLUMN     "linkPreviewThumbnail" TEXT,
ADD COLUMN     "linkPreviewTitle" TEXT,
ADD COLUMN     "linkPreviewUrl" TEXT,
ADD COLUMN     "storyReplyText" TEXT,
ADD COLUMN     "storyReplyThumbnail" TEXT;
