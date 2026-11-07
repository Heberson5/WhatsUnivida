-- Assistente Virtual (2.37.0): CPF search, confirmed client per conversation, audio transcription, assistant sessions,
-- phones already verified, "cadastro desatualizado" and the Fluxo step that hands over to the assistant.
ALTER TYPE "FlowNodeType" ADD VALUE IF NOT EXISTS 'AI_ASSISTANT';

ALTER TABLE "DataSourceRow" ADD COLUMN "cpfKey" TEXT;
CREATE INDEX "DataSourceRow_dataSourceId_cpfKey_idx" ON "DataSourceRow"("dataSourceId", "cpfKey");
-- Rows already stored: the digits of the column mapped as CPF/CNPJ (the next sync fills them too).
UPDATE "DataSourceRow" r
SET "cpfKey" = NULLIF(regexp_replace(r."data" ->> (s."columnMap" ->> 'cpf'), '\D', '', 'g'), '')
FROM "DataSource" s
WHERE r."dataSourceId" = s."id" AND s."columnMap" ? 'cpf';

ALTER TABLE "Conversation" ADD COLUMN "dataCpfKey" TEXT;
ALTER TABLE "Message" ADD COLUMN "transcription" TEXT;

CREATE TABLE "AiSession" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'NEW',
    "data" JSONB NOT NULL DEFAULT '{}',
    "lastHandledAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    CONSTRAINT "AiSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiSession_seq_key" ON "AiSession"("seq");
CREATE UNIQUE INDEX "AiSession_conversationId_key" ON "AiSession"("conversationId");
CREATE INDEX "AiSession_endedAt_lastActivityAt_idx" ON "AiSession"("endedAt", "lastActivityAt");
CREATE INDEX "AiSession_contactId_idx" ON "AiSession"("contactId");

CREATE TABLE "ContactCpfVerification" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "contactId" TEXT NOT NULL,
    "cpfKey" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContactCpfVerification_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContactCpfVerification_seq_key" ON "ContactCpfVerification"("seq");
CREATE UNIQUE INDEX "ContactCpfVerification_contactId_cpfKey_key" ON "ContactCpfVerification"("contactId", "cpfKey");

CREATE TABLE "ClientDataCorrection" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "contactId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "cpfKey" TEXT NOT NULL,
    "clientName" TEXT,
    "registeredAddress" TEXT,
    "informedName" TEXT,
    "informedAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedByName" TEXT,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "ClientDataCorrection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClientDataCorrection_seq_key" ON "ClientDataCorrection"("seq");
CREATE INDEX "ClientDataCorrection_contactId_resolvedAt_idx" ON "ClientDataCorrection"("contactId", "resolvedAt");
CREATE INDEX "ClientDataCorrection_cpfKey_resolvedAt_idx" ON "ClientDataCorrection"("cpfKey", "resolvedAt");
