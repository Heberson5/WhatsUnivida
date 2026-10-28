-- CreateEnum
CREATE TYPE "ChatMessageKind" AS ENUM ('TEXT', 'AUDIO', 'POLL', 'NUDGE');

-- AlterTable
ALTER TABLE "ChatMember" ADD COLUMN     "mutedUntil" TIMESTAMP(3),
ADD COLUMN     "pinnedAt" TIMESTAMP(3),
ADD COLUMN     "removedById" TEXT;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "audioDurationMs" INTEGER,
ADD COLUMN     "audioWaveform" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "kind" "ChatMessageKind" NOT NULL DEFAULT 'TEXT',
ADD COLUMN     "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "nudgeTargetId" TEXT,
ADD COLUMN     "replyToId" TEXT,
ADD COLUMN     "ttlFromRead" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ttlSeconds" INTEGER,
ADD COLUMN     "viewOnce" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ChatRoom" ADD COLUMN     "autoDeleteSeconds" INTEGER,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "icon" TEXT;

-- CreateTable
CREATE TABLE "ChatReadMark" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatReadMark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatDeliveryMark" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatDeliveryMark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessageEdit" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "body" TEXT,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessageEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatPoll" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "multiple" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ChatPoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatPollOption" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ChatPollOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatPollVote" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatPollVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatPin" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pinnedById" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "until" TIMESTAMP(3),

    CONSTRAINT "ChatPin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessageView" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessageView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatReadMark_roomId_readAt_idx" ON "ChatReadMark"("roomId", "readAt");

-- CreateIndex
CREATE INDEX "ChatDeliveryMark_userId_deliveredAt_idx" ON "ChatDeliveryMark"("userId", "deliveredAt");

-- CreateIndex
CREATE INDEX "ChatMessageEdit_messageId_idx" ON "ChatMessageEdit"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatReaction_messageId_userId_key" ON "ChatReaction"("messageId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatPoll_messageId_key" ON "ChatPoll"("messageId");

-- CreateIndex
CREATE INDEX "ChatPollVote_pollId_userId_idx" ON "ChatPollVote"("pollId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatPollVote_optionId_userId_key" ON "ChatPollVote"("optionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatPin_roomId_messageId_key" ON "ChatPin"("roomId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessageView_messageId_userId_key" ON "ChatMessageView"("messageId", "userId");

-- AddForeignKey
ALTER TABLE "ChatMessageEdit" ADD CONSTRAINT "ChatMessageEdit_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatReaction" ADD CONSTRAINT "ChatReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPoll" ADD CONSTRAINT "ChatPoll_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPollOption" ADD CONSTRAINT "ChatPollOption_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "ChatPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPollVote" ADD CONSTRAINT "ChatPollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "ChatPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPollVote" ADD CONSTRAINT "ChatPollVote_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "ChatPollOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPin" ADD CONSTRAINT "ChatPin_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "ChatRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessageView" ADD CONSTRAINT "ChatMessageView_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

