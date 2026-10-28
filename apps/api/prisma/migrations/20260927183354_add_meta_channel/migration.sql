-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('WHATSAPP', 'INSTAGRAM', 'MESSENGER');

-- CreateEnum
CREATE TYPE "MetaConnectionStatus" AS ENUM ('DISCONNECTED', 'CONNECTED');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "channel" "Channel" NOT NULL DEFAULT 'WHATSAPP',
ADD COLUMN     "externalUserId" TEXT,
ADD COLUMN     "metaConnectionId" TEXT,
ALTER COLUMN "whatsappConnectionId" DROP NOT NULL,
ALTER COLUMN "phone" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "channel" "Channel" NOT NULL DEFAULT 'WHATSAPP',
ADD COLUMN     "metaConnectionId" TEXT,
ALTER COLUMN "whatsappConnectionId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "MetaConnection" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#0097B4',
    "status" "MetaConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "externalPageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaConnection_channel_externalPageId_key" ON "MetaConnection"("channel", "externalPageId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_externalUserId_metaConnectionId_key" ON "Contact"("externalUserId", "metaConnectionId");

-- CreateIndex
CREATE INDEX "Conversation_metaConnectionId_idx" ON "Conversation"("metaConnectionId");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_metaConnectionId_fkey" FOREIGN KEY ("metaConnectionId") REFERENCES "MetaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_metaConnectionId_fkey" FOREIGN KEY ("metaConnectionId") REFERENCES "MetaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

