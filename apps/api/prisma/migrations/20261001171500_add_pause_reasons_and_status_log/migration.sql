-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pauseReasonId" TEXT,
ADD COLUMN     "pausedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PauseReason" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PauseReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentStatusLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AgentPresence" NOT NULL,
    "pauseReasonId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AgentStatusLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentStatusLog_userId_idx" ON "AgentStatusLog"("userId");

-- CreateIndex
CREATE INDEX "AgentStatusLog_startedAt_idx" ON "AgentStatusLog"("startedAt");

-- CreateIndex
CREATE INDEX "AgentStatusLog_pauseReasonId_idx" ON "AgentStatusLog"("pauseReasonId");

-- CreateIndex
CREATE INDEX "User_pauseReasonId_idx" ON "User"("pauseReasonId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_pauseReasonId_fkey" FOREIGN KEY ("pauseReasonId") REFERENCES "PauseReason"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentStatusLog" ADD CONSTRAINT "AgentStatusLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentStatusLog" ADD CONSTRAINT "AgentStatusLog_pauseReasonId_fkey" FOREIGN KEY ("pauseReasonId") REFERENCES "PauseReason"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

