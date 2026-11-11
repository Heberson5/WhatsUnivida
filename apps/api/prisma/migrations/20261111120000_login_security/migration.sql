-- Proteção de login: tentativas gravadas (sobrevivem a uma atualização do sistema), bloqueio por conta e troca
-- obrigatória da senha temporária.
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "ipAddress" TEXT,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoginAttempt_seq_key" ON "LoginAttempt"("seq");
CREATE INDEX "LoginAttempt_email_createdAt_idx" ON "LoginAttempt"("email", "createdAt");
CREATE INDEX "LoginAttempt_ipAddress_createdAt_idx" ON "LoginAttempt"("ipAddress", "createdAt");

CREATE TABLE "LoginLock" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginLock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LoginLock_seq_key" ON "LoginLock"("seq");
CREATE UNIQUE INDEX "LoginLock_email_key" ON "LoginLock"("email");

ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
