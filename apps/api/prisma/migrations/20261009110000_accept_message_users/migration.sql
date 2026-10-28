-- "Quem pode usar" on Respostas › Aceite: a message is sent for everyone (default — every existing row keeps
-- working as before) or only when one of the chosen users takes the conversation.

-- AlterTable
ALTER TABLE "AutoMessageTemplate" ADD COLUMN     "allUsers" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "_AutoMessageTemplateUsers" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_AutoMessageTemplateUsers_AB_unique" ON "_AutoMessageTemplateUsers"("A", "B");

-- CreateIndex
CREATE INDEX "_AutoMessageTemplateUsers_B_index" ON "_AutoMessageTemplateUsers"("B");

-- AddForeignKey
ALTER TABLE "_AutoMessageTemplateUsers" ADD CONSTRAINT "_AutoMessageTemplateUsers_A_fkey" FOREIGN KEY ("A") REFERENCES "AutoMessageTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AutoMessageTemplateUsers" ADD CONSTRAINT "_AutoMessageTemplateUsers_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Three acceptance messages to start from (see PROMPT: "Crie mais 3 Mensagens de Aceite para servir de modelo").
-- They ship INACTIVE: an active one would start going out to customers right after the deploy. Turning one on
-- (and choosing who uses it) is a decision for whoever manages Respostas › Aceite. Fixed ids so running this
-- again in any environment never duplicates them.
INSERT INTO "AutoMessageTemplate" ("id", "trigger", "name", "text", "active", "allConnections", "allUsers", "createdAt", "updatedAt")
VALUES
  (
    '7c1e4a52-3b8d-4f6a-9e21-0a5d8c3b1f01',
    'ACCEPT',
    'Modelo – Boas-vindas',
    E'Olá, {{cliente}}! Aqui é {{atendente}} e, a partir de agora, eu sigo com o seu atendimento.\nComo posso ajudar?',
    false, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    '7c1e4a52-3b8d-4f6a-9e21-0a5d8c3b1f02',
    'ACCEPT',
    'Modelo – Obrigado por aguardar',
    E'Olá, {{cliente}}! Obrigado por aguardar.\nSou {{atendente}} e vou cuidar da sua solicitação. Já estou lendo a nossa conversa e retorno em instantes.',
    false, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    '7c1e4a52-3b8d-4f6a-9e21-0a5d8c3b1f03',
    'ACCEPT',
    'Modelo – Atendimento especializado',
    E'Olá, {{cliente}}! Meu nome é {{atendente_nome}} e vou acompanhar o seu atendimento do início ao fim.\nPara agilizar, se tiver o número do pedido, protocolo ou CPF, já pode me enviar por aqui.',
    false, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
ON CONFLICT ("id") DO NOTHING;
