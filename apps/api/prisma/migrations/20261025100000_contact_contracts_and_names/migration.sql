-- Contatos › Contrato: every contract of the phone with its status (from the Fonte de dados).
ALTER TABLE "Contact" ADD COLUMN "contracts" JSONB;

-- Contatos › Padronizar nomes: what each apply changed, to undo it.
CREATE TABLE "ContactNameChange" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "oldName" TEXT,
    "newName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "ContactNameChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContactNameChange_batchId_idx" ON "ContactNameChange"("batchId");
CREATE INDEX "ContactNameChange_contactId_idx" ON "ContactNameChange"("contactId");
ALTER TABLE "ContactNameChange" ADD CONSTRAINT "ContactNameChange_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
