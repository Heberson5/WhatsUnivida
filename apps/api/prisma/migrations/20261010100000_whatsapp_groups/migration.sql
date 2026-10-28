-- AlterEnum
ALTER TYPE "ConversationStatus" ADD VALUE 'GROUP';

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "groupParticipantsCount" INTEGER,
ADD COLUMN     "isGroup" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "senderParticipantJid" TEXT,
ADD COLUMN     "senderParticipantName" TEXT,
ADD COLUMN     "senderParticipantPhone" TEXT;

-- AlterTable
ALTER TABLE "WhatsAppConnection" ADD COLUMN     "groupsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "groupsEnabledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "GroupReadState" (
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,
    "firstOpenedAt" TIMESTAMP(3),
    "lastOpenedAt" TIMESTAMP(3),
    "mutedAt" TIMESTAMP(3),

    CONSTRAINT "GroupReadState_pkey" PRIMARY KEY ("conversationId","userId")
);

-- CreateIndex
CREATE INDEX "GroupReadState_userId_idx" ON "GroupReadState"("userId");

-- AddForeignKey
ALTER TABLE "GroupReadState" ADD CONSTRAINT "GroupReadState_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupReadState" ADD CONSTRAINT "GroupReadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

