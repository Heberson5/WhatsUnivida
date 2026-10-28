-- CreateEnum
CREATE TYPE "DataSourceKind" AS ENUM ('LINK', 'MICROSOFT', 'UPLOAD', 'DATABASE');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "dataClientKey" TEXT,
ADD COLUMN     "dataSuspensionAckAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DataSourceKind" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" TEXT,
    "columnMap" JSONB NOT NULL DEFAULT '{}',
    "sensitiveColumns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "overrideContactName" BOOLEAN NOT NULL DEFAULT false,
    "maxAgeHours" INTEGER NOT NULL DEFAULT 24,
    "refreshMinutes" INTEGER NOT NULL DEFAULT 60,
    "columns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "dataUpdatedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSourceRow" (
    "id" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "phoneKey" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "DataSourceRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataSourceRow_dataSourceId_phoneKey_idx" ON "DataSourceRow"("dataSourceId", "phoneKey");

-- AddForeignKey
ALTER TABLE "DataSourceRow" ADD CONSTRAINT "DataSourceRow_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

