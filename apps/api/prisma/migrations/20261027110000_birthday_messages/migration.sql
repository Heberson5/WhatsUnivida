-- CreateEnum
CREATE TYPE "BirthdayKind" AS ENUM ('HOLDER', 'BENEFICIARY');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "birthdays" JSONB;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "birthdayAckAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BirthdayMessage" (
    "id" TEXT NOT NULL,
    "kind" "BirthdayKind" NOT NULL,
    "text" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mediaStorageKey" TEXT,
    "mediaFileName" TEXT,
    "mediaMimeType" TEXT,
    "mediaSizeBytes" INTEGER,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BirthdayMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BirthdayGreeting" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "personKey" TEXT NOT NULL,
    "personName" TEXT NOT NULL,
    "kind" "BirthdayKind" NOT NULL,
    "year" INTEGER NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sentById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BirthdayGreeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BirthdayMessage_kind_key" ON "BirthdayMessage"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "BirthdayGreeting_contactId_personKey_year_key" ON "BirthdayGreeting"("contactId", "personKey", "year");


-- The two messages ship already written (Respostas › Aniversários edits them).
INSERT INTO "BirthdayMessage" ("id", "kind", "text", "active", "updatedAt") VALUES
  (gen_random_uuid()::text, 'HOLDER', E'{{saudacao}}, {{primeiro_nome}}! 🎉\n\nHoje o dia é seu, e a gente não podia deixar passar! Toda a nossa equipe deseja um feliz aniversário, com muita saúde, paz e alegria ao lado de quem você ama. 🎂🎈\n\nObrigado por fazer parte da nossa história. Conte sempre com a gente! 💙', true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'BENEFICIARY', E'{{saudacao}}, {{primeiro_nome}}! 🎉\n\nHoje é aniversário de {{aniversariante}} ({{parentesco}}), e a gente quer fazer parte dessa alegria! Mande para {{aniversariante_primeiro_nome}} um abraço carinhoso de toda a nossa equipe, com votos de muita saúde, paz e felicidade. 🎂💐', true, CURRENT_TIMESTAMP);
