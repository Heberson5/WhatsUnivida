-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "interventionById" TEXT,
ADD COLUMN     "interventionStartedAt" TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_interventionById_fkey" FOREIGN KEY ("interventionById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

