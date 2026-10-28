-- CreateEnum
CREATE TYPE "WhatsAppConnectionMode" AS ENUM ('QRCODE', 'OFFICIAL_API');

-- AlterTable
ALTER TABLE "WhatsAppConnection" ADD COLUMN     "accessToken" TEXT,
ADD COLUMN     "businessName" TEXT,
ADD COLUMN     "connectionMode" "WhatsAppConnectionMode" NOT NULL DEFAULT 'QRCODE',
ADD COLUMN     "displayPhoneNumber" TEXT,
ADD COLUMN     "phoneNumberId" TEXT,
ADD COLUMN     "wabaId" TEXT,
ADD COLUMN     "webhookVerifyToken" TEXT;

