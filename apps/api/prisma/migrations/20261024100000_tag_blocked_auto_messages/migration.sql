-- Etiquetas › "Não enviar estas mensagens automáticas" replaces "Não enviar pesquisa".
ALTER TABLE "Tag" ADD COLUMN "blockedAutoMessages" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "Tag" SET "blockedAutoMessages" = ARRAY['SURVEY']::TEXT[] WHERE "skipSurvey" = true;
ALTER TABLE "Tag" DROP COLUMN "skipSurvey";

-- Automatic messages waiting their 3–10 seconds.
CREATE TABLE "PendingAutoMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "outcome" TEXT,

    CONSTRAINT "PendingAutoMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PendingAutoMessage_resolvedAt_dueAt_idx" ON "PendingAutoMessage"("resolvedAt", "dueAt");
CREATE INDEX "PendingAutoMessage_conversationId_idx" ON "PendingAutoMessage"("conversationId");
ALTER TABLE "PendingAutoMessage" ADD CONSTRAINT "PendingAutoMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Relatórios › Mensagens automáticas bloqueadas.
CREATE TABLE "AutoMessageBlockLog" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tagId" TEXT,
    "tagName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutoMessageBlockLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AutoMessageBlockLog_createdAt_idx" ON "AutoMessageBlockLog"("createdAt");
CREATE INDEX "AutoMessageBlockLog_conversationId_kind_idx" ON "AutoMessageBlockLog"("conversationId", "kind");
ALTER TABLE "AutoMessageBlockLog" ADD CONSTRAINT "AutoMessageBlockLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutoMessageBlockLog" ADD CONSTRAINT "AutoMessageBlockLog_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE SET NULL ON UPDATE CASCADE;
