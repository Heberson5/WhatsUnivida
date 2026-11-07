-- Cadastro desatualizado: the phone that talked to the Assistente Virtual isn't on the confirmed CPF's record.
ALTER TABLE "ClientDataCorrection" ADD COLUMN "contactPhone" TEXT;
ALTER TABLE "ClientDataCorrection" ADD COLUMN "registeredPhones" TEXT;
