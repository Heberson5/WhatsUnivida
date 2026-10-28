-- Respostas: one image, video or PDF on a quick reply or closing message (its text goes as the caption).
ALTER TABLE "QuickReply" ADD COLUMN "mediaStorageKey" TEXT,
ADD COLUMN "mediaFileName" TEXT,
ADD COLUMN "mediaMimeType" TEXT,
ADD COLUMN "mediaSizeBytes" INTEGER;

ALTER TABLE "ClosingMessage" ADD COLUMN "mediaStorageKey" TEXT,
ADD COLUMN "mediaFileName" TEXT,
ADD COLUMN "mediaMimeType" TEXT,
ADD COLUMN "mediaSizeBytes" INTEGER;

-- The closing message's attachment held for a survey until it is sent.
ALTER TABLE "SatisfactionSurvey" ADD COLUMN "closingMedia" JSONB;
