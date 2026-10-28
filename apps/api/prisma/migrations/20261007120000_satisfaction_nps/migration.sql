-- AlterTable
ALTER TABLE "SatisfactionSurvey" ADD COLUMN     "questionId" TEXT;

-- CreateTable
CREATE TABLE "SatisfactionQuestion" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SatisfactionQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SatisfactionSurvey_questionId_idx" ON "SatisfactionSurvey"("questionId");

-- AddForeignKey
ALTER TABLE "SatisfactionSurvey" ADD CONSTRAINT "SatisfactionSurvey_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "SatisfactionQuestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The survey now asks for a 0-10 score (NPS) instead of 1-5. A survey saved
-- before this change asks the old question, so it is switched off until someone
-- reviews it in Respostas > Pesquisa (the untouched default text is replaced by
-- the new default; a customized text is kept for them to rewrite).
UPDATE "SystemSetting"
SET "value" = jsonb_set(
    CASE
        WHEN "value"->>'question' = 'Como você avalia o atendimento que recebeu? Responda com uma nota de 1 a 5, sendo 1 muito insatisfeito e 5 muito satisfeito.'
        THEN jsonb_set("value", '{question}', to_jsonb('Em uma escala de 0 a 10, o quanto você recomendaria o nosso atendimento a um amigo ou colega? Responda apenas com o número, sendo 0 nada provável e 10 muito provável.'::text))
        ELSE "value"
    END,
    '{enabled}',
    'false'::jsonb
)
WHERE "key" = 'satisfactionSurvey';

-- Surveys already sent were answered on the old 1-5 scale (questionId stays
-- null for them). Stop accepting answers on the ones still waiting so a 0-10
-- reply is never filed under that scale.
UPDATE "SatisfactionSurvey"
SET "expiresAt" = CURRENT_TIMESTAMP
WHERE "answeredAt" IS NULL AND "expiresAt" > CURRENT_TIMESTAMP;
