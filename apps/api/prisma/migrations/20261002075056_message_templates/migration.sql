-- CreateEnum
CREATE TYPE "MessageTemplateCategory" AS ENUM ('MARKETING', 'UTILITY', 'AUTHENTICATION');

-- CreateEnum
CREATE TYPE "MessageTemplateHeaderType" AS ENUM ('NONE', 'TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "MessageTemplateStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED');

-- AlterTable
ALTER TABLE "WhatsAppConnection" ADD COLUMN     "appId" TEXT;

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "MessageTemplateCategory" NOT NULL,
    "language" TEXT NOT NULL,
    "headerType" "MessageTemplateHeaderType" NOT NULL DEFAULT 'NONE',
    "headerText" TEXT,
    "headerSampleFileName" TEXT,
    "headerSampleMimeType" TEXT,
    "headerSampleSizeBytes" INTEGER,
    "headerSampleStorageKey" TEXT,
    "bodyText" TEXT NOT NULL,
    "footerText" TEXT,
    "buttons" JSONB,
    "whatsappConnectionId" TEXT NOT NULL,
    "status" "MessageTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "rejectionReason" TEXT,
    "metaTemplateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_metaTemplateId_key" ON "MessageTemplate"("metaTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_whatsappConnectionId_name_language_key" ON "MessageTemplate"("whatsappConnectionId", "name", "language");

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_whatsappConnectionId_fkey" FOREIGN KEY ("whatsappConnectionId") REFERENCES "WhatsAppConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

