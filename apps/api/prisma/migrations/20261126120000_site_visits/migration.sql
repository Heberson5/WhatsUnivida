-- Acessos ao site: one row per visit to a public page (anonymous: no IP, no cookie, no name).
-- CreateTable
CREATE TABLE "SiteVisit" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "visitorId" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT,
    "referrer" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "device" TEXT NOT NULL,
    "browser" TEXT,
    "os" TEXT,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "loggedIn" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SiteVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteVisit_seq_key" ON "SiteVisit"("seq");

-- CreateIndex
CREATE INDEX "SiteVisit_startedAt_idx" ON "SiteVisit"("startedAt");

-- CreateIndex
CREATE INDEX "SiteVisit_site_startedAt_idx" ON "SiteVisit"("site", "startedAt");

-- CreateIndex
CREATE INDEX "SiteVisit_lastSeenAt_idx" ON "SiteVisit"("lastSeenAt");

-- CreateIndex
CREATE INDEX "SiteVisit_visitorId_idx" ON "SiteVisit"("visitorId");

