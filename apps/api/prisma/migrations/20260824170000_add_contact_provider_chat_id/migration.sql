-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "providerChatId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Contact_providerChatId_whatsappConnectionId_key" ON "Contact"("providerChatId", "whatsappConnectionId");
