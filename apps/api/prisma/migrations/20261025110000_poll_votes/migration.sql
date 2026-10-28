-- Enquetes nos grupos: the key to read the votes, and the votes.
ALTER TABLE "MessageAttachment" ADD COLUMN "pollSelectableCount" INTEGER;
ALTER TABLE "MessageAttachment" ADD COLUMN "pollSecret" TEXT;
ALTER TABLE "MessageAttachment" ADD COLUMN "pollCreatorJid" TEXT;

CREATE TABLE "PollVote" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "voterJid" TEXT NOT NULL,
    "voterName" TEXT,
    "voterPhone" TEXT,
    "options" TEXT[],
    "votedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PollVote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PollVote_attachmentId_voterJid_key" ON "PollVote"("attachmentId", "voterJid");
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "MessageAttachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
