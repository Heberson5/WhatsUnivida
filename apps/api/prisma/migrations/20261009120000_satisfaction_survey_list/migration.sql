-- Respostas › Pesquisa becomes a list of surveys (see PROMPT: "Cadastre ao menos 4 pesquisas desligadas, para
-- servir de modelo"). Only active ones are sent; per conversation the most specific one applies.

-- AlterTable
ALTER TABLE "SatisfactionSurvey" ADD COLUMN     "configId" TEXT;

-- CreateTable
CREATE TABLE "SatisfactionSurveyConfig" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "allConnections" BOOLEAN NOT NULL DEFAULT false,
    "question" TEXT NOT NULL,
    "thanks" TEXT NOT NULL,
    "answerWindowHours" INTEGER NOT NULL DEFAULT 24,
    "closingWaitMinutes" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SatisfactionSurveyConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_SatisfactionSurveyConnections" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_SatisfactionSurveyConnections_AB_unique" ON "_SatisfactionSurveyConnections"("A", "B");

-- CreateIndex
CREATE INDEX "_SatisfactionSurveyConnections_B_index" ON "_SatisfactionSurveyConnections"("B");

-- AddForeignKey
ALTER TABLE "SatisfactionSurvey" ADD CONSTRAINT "SatisfactionSurvey_configId_fkey" FOREIGN KEY ("configId") REFERENCES "SatisfactionSurveyConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SatisfactionSurveyConnections" ADD CONSTRAINT "_SatisfactionSurveyConnections_A_fkey" FOREIGN KEY ("A") REFERENCES "SatisfactionSurveyConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SatisfactionSurveyConnections" ADD CONSTRAINT "_SatisfactionSurveyConnections_B_fkey" FOREIGN KEY ("B") REFERENCES "WhatsAppConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The survey as it was set up until now (one settings object) becomes the first row, exactly as it was — on or off,
-- same connections, texts and waits — so nothing changes for the customers.
INSERT INTO "SatisfactionSurveyConfig" ("id", "name", "active", "allConnections", "question", "thanks", "answerWindowHours", "closingWaitMinutes", "createdAt", "updatedAt")
SELECT
  '3d6f2a10-8c4b-4e7a-b1d2-5f9e0c7a4b00',
  'Pesquisa de satisfação',
  COALESCE(("value"->>'enabled')::boolean, false),
  COALESCE(("value"->>'allConnections')::boolean, false),
  COALESCE(NULLIF("value"->>'question', ''), 'Em uma escala de 0 a 10, o quanto você recomendaria o nosso atendimento a um amigo ou colega? Responda apenas com o número, sendo 0 nada provável e 10 muito provável.'),
  COALESCE(NULLIF("value"->>'thanks', ''), 'Obrigado pela sua avaliação!'),
  COALESCE(("value"->>'answerWindowHours')::int, 24),
  COALESCE(("value"->>'closingWaitMinutes')::int, 30),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "SystemSetting"
WHERE "key" = 'satisfactionSurvey';

INSERT INTO "_SatisfactionSurveyConnections" ("A", "B")
SELECT DISTINCT '3d6f2a10-8c4b-4e7a-b1d2-5f9e0c7a4b00', c."id"
FROM "SystemSetting" s
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(s."value"->'connectionIds', '[]'::jsonb)) AS chosen(id)
JOIN "WhatsAppConnection" c ON c."id" = chosen.id
WHERE s."key" = 'satisfactionSurvey' AND NOT COALESCE((s."value"->>'allConnections')::boolean, false);

-- Surveys already sent came from that one: a score still on its way gets its thank-you from it.
UPDATE "SatisfactionSurvey" SET "configId" = '3d6f2a10-8c4b-4e7a-b1d2-5f9e0c7a4b00'
WHERE "questionId" IS NOT NULL AND EXISTS (SELECT 1 FROM "SatisfactionSurveyConfig" WHERE "id" = '3d6f2a10-8c4b-4e7a-b1d2-5f9e0c7a4b00');

DELETE FROM "SystemSetting" WHERE "key" = 'satisfactionSurvey';

-- Four surveys to start from — OFF and with no connection: nothing is sent until someone chooses the connections and
-- switches one on. All ask for a 0–10 score, so each one gets its own NPS in the Dashboard. Fixed ids so they are
-- never duplicated.
INSERT INTO "SatisfactionSurveyConfig" ("id", "name", "active", "allConnections", "question", "thanks", "answerWindowHours", "closingWaitMinutes", "createdAt", "updatedAt")
VALUES
  (
    '3d6f2a10-8c4b-4e7a-b1d2-5f9e0c7a4b01',
    'Modelo – Indicação (NPS)',
    false, false,
    'Em uma escala de 0 a 10, o quanto você recomendaria o nosso atendimento a um amigo ou colega? Responda apenas com o número, sendo 0 nada provável e 10 muito provável.',
    'Obrigado pela sua avaliação! Ela nos ajuda a melhorar o nosso atendimento.',
    24, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    '3d6f2a10-8c4b-4e7a-b1d2-5f9e0c7a4b02',
    'Modelo – Nota do atendimento',
    false, false,
    'Que nota você dá para o atendimento que recebeu hoje? Responda apenas com o número, de 0 a 10, sendo 0 muito insatisfeito e 10 muito satisfeito.',
    'Muito obrigado pela sua nota! 😊',
    24, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    '3d6f2a10-8c4b-4e7a-b1d2-5f9e0c7a4b03',
    'Modelo – Solicitação resolvida',
    false, false,
    'De 0 a 10, o quanto a sua solicitação foi resolvida neste atendimento? Responda apenas com o número, sendo 0 nada resolvida e 10 totalmente resolvida.',
    'Obrigado! A sua resposta nos ajuda a resolver cada vez melhor.',
    24, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    '3d6f2a10-8c4b-4e7a-b1d2-5f9e0c7a4b04',
    'Modelo – Agilidade',
    false, false,
    'De 0 a 10, como você avalia a rapidez do nosso atendimento? Responda apenas com o número, sendo 0 muito demorado e 10 muito rápido.',
    'Obrigado pela avaliação! Seguimos trabalhando para atender você cada vez mais rápido.',
    24, 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
ON CONFLICT ("id") DO NOTHING;
