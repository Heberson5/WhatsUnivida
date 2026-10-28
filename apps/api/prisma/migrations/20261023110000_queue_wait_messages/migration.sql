-- Respostas › Espera na fila
CREATE TABLE "QueueWaitMessage" (
    "id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "delayMinutes" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "allConnections" BOOLEAN NOT NULL DEFAULT true,
    "mediaStorageKey" TEXT,
    "mediaFileName" TEXT,
    "mediaMimeType" TEXT,
    "mediaSizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueWaitMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "QueueWaitMessage_position_idx" ON "QueueWaitMessage"("position");

CREATE TABLE "_QueueWaitMessageConnections" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

CREATE UNIQUE INDEX "_QueueWaitMessageConnections_AB_unique" ON "_QueueWaitMessageConnections"("A", "B");
CREATE INDEX "_QueueWaitMessageConnections_B_index" ON "_QueueWaitMessageConnections"("B");

ALTER TABLE "_QueueWaitMessageConnections" ADD CONSTRAINT "_QueueWaitMessageConnections_A_fkey" FOREIGN KEY ("A") REFERENCES "QueueWaitMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_QueueWaitMessageConnections" ADD CONSTRAINT "_QueueWaitMessageConnections_B_fkey" FOREIGN KEY ("B") REFERENCES "WhatsAppConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Progress of each conversation through the sequence.
ALTER TABLE "Conversation" ADD COLUMN "queueWaitStep" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN "queueWaitQueueAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "queueWaitLastAt" TIMESTAMP(3);
