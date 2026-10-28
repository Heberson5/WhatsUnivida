-- Data sources per connection, and each bank's boleto layout per source.
ALTER TABLE "DataSource" ADD COLUMN "allConnections" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "DataSource" ADD COLUMN "connectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "DataSource" ADD COLUMN "bankLayouts" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "BoletoLayout" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "perPage" INTEGER NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoletoLayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoletoInstruction" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "finePercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "interestMonthPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoletoInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BoletoLayout_bankCode_name_key" ON "BoletoLayout"("bankCode", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BoletoInstruction_name_key" ON "BoletoInstruction"("name");
