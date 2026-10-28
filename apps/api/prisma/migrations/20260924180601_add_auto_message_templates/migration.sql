-- CreateEnum
CREATE TYPE "AutoMessageTrigger" AS ENUM ('TRANSFER', 'ACCEPT');

-- CreateTable
CREATE TABLE "AutoMessageTemplate" (
    "id" TEXT NOT NULL,
    "trigger" "AutoMessageTrigger" NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoMessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutoMessageTemplate_trigger_idx" ON "AutoMessageTemplate"("trigger");

-- Default TRANSFER auto-message — exact wording reviewed and approved
-- before this feature was built (see PROMPT history: "Esta conversa foi
-- transferida para {{atendente}}." on its own line, then "Em breve você
-- será atendido(a)." on the next). Ships active so the feature works
-- right after this migration runs, with no manual setup step first. No
-- default ACCEPT row: that wording was never reviewed, so it stays an
-- empty list (Respostas > Aceite) until someone deliberately creates one.
INSERT INTO "AutoMessageTemplate" ("id", "trigger", "name", "text", "active", "createdAt", "updatedAt")
VALUES (
  '5f2b6e2e-6c1a-4b3a-9b8a-1f0c9d7a2e10',
  'TRANSFER',
  'Aviso de transferência',
  E'Esta conversa foi transferida para {{atendente}}.\nEm breve você será atendido(a).',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
