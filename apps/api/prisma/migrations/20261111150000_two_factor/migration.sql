-- Verificação em duas etapas (aplicativo autenticador): segredo criptografado, quando foi ativada, o último código
-- aceito (um código não vale duas vezes) e os códigos de recuperação (só o hash de cada um).
ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "totpEnabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "totpLastStep" INTEGER;
ALTER TABLE "User" ADD COLUMN "totpRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];
