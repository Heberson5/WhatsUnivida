-- CreateEnum
CREATE TYPE "AnnouncementKind" AS ENUM ('INFO', 'IMPORTANT', 'URGENT', 'CELEBRATION', 'NEWS');

-- CreateEnum
CREATE TYPE "AnnouncementLayout" AS ENUM ('COVER', 'POSTER', 'TEXT');

-- CreateEnum
CREATE TYPE "AnnouncementDisplay" AS ENUM ('POPUP_AND_BOARD', 'BOARD_ONLY');

-- CreateEnum
CREATE TYPE "AnnouncementRecurrence" AS ENUM ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ReportScheduleFrequency" AS ENUM ('DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'YEARLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ReportScheduleRunStatus" AS ENUM ('SENT', 'PARTIAL', 'FAILED', 'RETRYING');

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "loginId" TEXT;

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "kind" "AnnouncementKind" NOT NULL DEFAULT 'INFO',
    "layout" "AnnouncementLayout" NOT NULL DEFAULT 'COVER',
    "display" "AnnouncementDisplay" NOT NULL DEFAULT 'POPUP_AND_BOARD',
    "category" TEXT,
    "requireAck" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "linkUrl" TEXT,
    "linkLabel" TEXT,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT,
    "recurrence" "AnnouncementRecurrence" NOT NULL DEFAULT 'ONCE',
    "audience" JSONB NOT NULL,
    "images" JSONB NOT NULL DEFAULT '[]',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementReceipt" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "ackAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),

    CONSTRAINT "AnnouncementReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementDelivery" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "sessionIds" TEXT[],
    "lastShownAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementReaction" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "subject" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "to" TEXT[],
    "cc" TEXT[],
    "frequency" "ReportScheduleFrequency" NOT NULL,
    "time" TEXT NOT NULL,
    "tzOffsetMinutes" INTEGER NOT NULL DEFAULT 240,
    "startDate" TEXT NOT NULL,
    "weekdays" INTEGER[],
    "monthDay" INTEGER,
    "month" INTEGER,
    "customInterval" INTEGER NOT NULL DEFAULT 1,
    "customUnit" TEXT NOT NULL DEFAULT 'DAY',
    "endType" TEXT NOT NULL DEFAULT 'NEVER',
    "endAfter" INTEGER,
    "endDate" TEXT,
    "skipSaturday" BOOLEAN NOT NULL DEFAULT false,
    "skipSunday" BOOLEAN NOT NULL DEFAULT false,
    "period" TEXT NOT NULL DEFAULT 'AUTO',
    "agentId" TEXT,
    "connectionIds" TEXT[],
    "alerts" JSONB NOT NULL DEFAULT '{}',
    "nextRunAt" TIMESTAMP(3),
    "retryAt" TIMESTAMP(3),
    "retryAttempt" INTEGER NOT NULL DEFAULT 0,
    "retryFor" TIMESTAMP(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" "ReportScheduleRunStatus",
    "lastError" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportScheduleRun" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "status" "ReportScheduleRunStatus" NOT NULL,
    "recipients" TEXT[],
    "rejected" TEXT[],
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportScheduleRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Announcement_deletedAt_startDate_idx" ON "Announcement"("deletedAt", "startDate");

-- CreateIndex
CREATE INDEX "AnnouncementReceipt_userId_idx" ON "AnnouncementReceipt"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementReceipt_announcementId_userId_key" ON "AnnouncementReceipt"("announcementId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementDelivery_announcementId_userId_day_key" ON "AnnouncementDelivery"("announcementId", "userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementReaction_announcementId_userId_emoji_key" ON "AnnouncementReaction"("announcementId", "userId", "emoji");

-- CreateIndex
CREATE INDEX "ReportSchedule_enabled_nextRunAt_idx" ON "ReportSchedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "ReportScheduleRun_scheduleId_createdAt_idx" ON "ReportScheduleRun"("scheduleId", "createdAt");

-- AddForeignKey
ALTER TABLE "AnnouncementReceipt" ADD CONSTRAINT "AnnouncementReceipt_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementDelivery" ADD CONSTRAINT "AnnouncementDelivery_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementReaction" ADD CONSTRAINT "AnnouncementReaction_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportScheduleRun" ADD CONSTRAINT "ReportScheduleRun_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "ReportSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

