-- Encerramento por falta de retorno: the closing message that goes out instead once the customer answers the survey.
ALTER TABLE "SatisfactionSurvey" ADD COLUMN "closingWhenAnswered" JSONB;
