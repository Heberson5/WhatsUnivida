-- CreateTable
CREATE TABLE "QuickReply" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortcut" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "whatsappConnectionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuickReply_whatsappConnectionId_shortcut_key" ON "QuickReply"("whatsappConnectionId", "shortcut");

-- AddForeignKey
ALTER TABLE "QuickReply" ADD CONSTRAINT "QuickReply_whatsappConnectionId_fkey" FOREIGN KEY ("whatsappConnectionId") REFERENCES "WhatsAppConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
