-- AlterTable
ALTER TABLE "User" ADD COLUMN     "closingMessageId" TEXT;

-- CreateTable
CREATE TABLE "ClosingMessage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClosingMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_closingMessageId_idx" ON "User"("closingMessageId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_closingMessageId_fkey" FOREIGN KEY ("closingMessageId") REFERENCES "ClosingMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
