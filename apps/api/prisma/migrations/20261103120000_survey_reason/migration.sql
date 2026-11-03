-- AlterTable
ALTER TABLE "SatisfactionSurveyConfig"
  ADD COLUMN "reasonEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reasonMinScore" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reasonMaxScore" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "reasonQuestion" TEXT NOT NULL DEFAULT 'Sentimos muito pela sua experiência, {{primeiro_nome}}. Pode nos contar o que mais influenciou sua nota?',
  ADD COLUMN "reasonThanks" TEXT NOT NULL DEFAULT 'Obrigado pelo retorno, {{primeiro_nome}}. Vamos usar sua opinião para melhorar nosso atendimento.';

-- AlterTable
ALTER TABLE "SatisfactionSurvey"
  ADD COLUMN "reasonAskedAt" TIMESTAMP(3),
  ADD COLUMN "reasonText" TEXT,
  ADD COLUMN "reasonAnsweredAt" TIMESTAMP(3),
  ADD COLUMN "reasonTimedOutAt" TIMESTAMP(3);

-- The surveys already switched on ask the reason of a 0 to 6 from now on.
UPDATE "SatisfactionSurveyConfig" SET "reasonEnabled" = true WHERE "active" = true;
