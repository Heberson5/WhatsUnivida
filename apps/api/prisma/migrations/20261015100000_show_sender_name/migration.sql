-- AlterTable
ALTER TABLE "AutoMessageTemplate" ADD COLUMN     "showSenderName" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ClosingMessage" ADD COLUMN     "showSenderName" BOOLEAN NOT NULL DEFAULT true;

