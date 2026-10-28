-- CreateEnum
CREATE TYPE "HolidayScope" AS ENUM ('NATIONAL', 'STATE', 'MUNICIPAL');

-- CreateEnum
CREATE TYPE "HolidaySource" AS ENUM ('MANUAL', 'AUTO');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accessSchedule" JSONB,
ADD COLUMN     "workCity" TEXT,
ADD COLUMN     "workState" TEXT;

-- CreateTable
CREATE TABLE "Holiday" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "HolidayScope" NOT NULL,
    "state" TEXT,
    "city" TEXT,
    "source" "HolidaySource" NOT NULL,
    "year" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HolidaySyncCursor" (
    "id" TEXT NOT NULL,
    "scope" "HolidayScope" NOT NULL,
    "state" TEXT,
    "city" TEXT,
    "year" INTEGER NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HolidaySyncCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Holiday_scope_state_city_year_idx" ON "Holiday"("scope", "state", "city", "year");

-- CreateIndex
CREATE INDEX "Holiday_date_idx" ON "Holiday"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_scope_state_city_date_name_source_key" ON "Holiday"("scope", "state", "city", "date", "name", "source");

-- CreateIndex
CREATE UNIQUE INDEX "HolidaySyncCursor_scope_state_city_year_key" ON "HolidaySyncCursor"("scope", "state", "city", "year");
