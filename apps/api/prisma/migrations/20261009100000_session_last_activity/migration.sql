-- AlterTable: sessions open at deploy time start counting their inactivity from now.
ALTER TABLE "RefreshToken" ADD COLUMN     "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
