-- AlterEnum
ALTER TYPE "ConversationStatus" ADD VALUE 'IN_FLOW';

-- AlterEnum
ALTER TYPE "FlowNodeType" ADD VALUE 'BUSINESS_HOURS';

-- AlterTable
ALTER TABLE "FlowSession" ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "invalidAttempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "automatedBy" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "FlowSession_conversationId_key" ON "FlowSession"("conversationId");

-- AddForeignKey
ALTER TABLE "FlowSession" ADD CONSTRAINT "FlowSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

