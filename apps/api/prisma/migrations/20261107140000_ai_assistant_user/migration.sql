-- Assistente Virtual as an attendant in the reports: its own (always inactive) user row.
ALTER TABLE "User" ADD COLUMN "isAssistant" BOOLEAN NOT NULL DEFAULT false;
