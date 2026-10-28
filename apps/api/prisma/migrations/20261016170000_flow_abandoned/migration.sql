-- AlterEnum
ALTER TYPE "ConversationStatus" ADD VALUE 'FLOW_ABANDONED';

-- DropForeignKey
ALTER TABLE "ConversationNote" DROP CONSTRAINT "ConversationNote_authorId_fkey";

-- AlterTable
ALTER TABLE "ConversationNote" ALTER COLUMN "authorId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "FlowSession" ADD COLUMN     "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AddForeignKey
ALTER TABLE "ConversationNote" ADD CONSTRAINT "ConversationNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

