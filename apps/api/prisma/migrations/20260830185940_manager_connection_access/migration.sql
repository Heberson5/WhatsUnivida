-- AlterTable
ALTER TABLE "WhatsAppConnection" ADD COLUMN     "createdByUserId" TEXT;

-- CreateTable
CREATE TABLE "ManagerConnectionAccess" (
    "id" TEXT NOT NULL,
    "managerId" TEXT NOT NULL,
    "whatsappConnectionId" TEXT NOT NULL,
    "canManage" BOOLEAN NOT NULL DEFAULT false,
    "canReceiveConversations" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagerConnectionAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagerConnectionAccess_managerId_whatsappConnectionId_key" ON "ManagerConnectionAccess"("managerId", "whatsappConnectionId");

-- AddForeignKey
ALTER TABLE "WhatsAppConnection" ADD CONSTRAINT "WhatsAppConnection_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerConnectionAccess" ADD CONSTRAINT "ManagerConnectionAccess_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagerConnectionAccess" ADD CONSTRAINT "ManagerConnectionAccess_whatsappConnectionId_fkey" FOREIGN KEY ("whatsappConnectionId") REFERENCES "WhatsAppConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
