-- DropForeignKey
ALTER TABLE "QuickReply" DROP CONSTRAINT "QuickReply_whatsappConnectionId_fkey";

-- DropIndex
DROP INDEX "QuickReply_whatsappConnectionId_shortcut_key";

-- AlterTable
ALTER TABLE "AutoMessageTemplate" ADD COLUMN     "allConnections" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ClosingMessage" ADD COLUMN     "allConnections" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "QuickReply" ADD COLUMN     "allConnections" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "_QuickReplyConnections" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "_AutoMessageTemplateConnections" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "_ClosingMessageConnections" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_QuickReplyConnections_AB_unique" ON "_QuickReplyConnections"("A", "B");

-- CreateIndex
CREATE INDEX "_QuickReplyConnections_B_index" ON "_QuickReplyConnections"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_AutoMessageTemplateConnections_AB_unique" ON "_AutoMessageTemplateConnections"("A", "B");

-- CreateIndex
CREATE INDEX "_AutoMessageTemplateConnections_B_index" ON "_AutoMessageTemplateConnections"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_ClosingMessageConnections_AB_unique" ON "_ClosingMessageConnections"("A", "B");

-- CreateIndex
CREATE INDEX "_ClosingMessageConnections_B_index" ON "_ClosingMessageConnections"("B");

-- Existing quick replies keep the single connection they already had.
INSERT INTO "_QuickReplyConnections" ("A", "B") SELECT "id", "whatsappConnectionId" FROM "QuickReply";

-- AlterTable
ALTER TABLE "QuickReply" DROP COLUMN "whatsappConnectionId";

-- CreateIndex
CREATE INDEX "QuickReply_shortcut_idx" ON "QuickReply"("shortcut");

-- AddForeignKey
ALTER TABLE "_QuickReplyConnections" ADD CONSTRAINT "_QuickReplyConnections_A_fkey" FOREIGN KEY ("A") REFERENCES "QuickReply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_QuickReplyConnections" ADD CONSTRAINT "_QuickReplyConnections_B_fkey" FOREIGN KEY ("B") REFERENCES "WhatsAppConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AutoMessageTemplateConnections" ADD CONSTRAINT "_AutoMessageTemplateConnections_A_fkey" FOREIGN KEY ("A") REFERENCES "AutoMessageTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AutoMessageTemplateConnections" ADD CONSTRAINT "_AutoMessageTemplateConnections_B_fkey" FOREIGN KEY ("B") REFERENCES "WhatsAppConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClosingMessageConnections" ADD CONSTRAINT "_ClosingMessageConnections_A_fkey" FOREIGN KEY ("A") REFERENCES "ClosingMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ClosingMessageConnections" ADD CONSTRAINT "_ClosingMessageConnections_B_fkey" FOREIGN KEY ("B") REFERENCES "WhatsAppConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

