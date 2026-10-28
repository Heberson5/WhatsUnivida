-- Notas de versão move from the code to the database, so an administrator can edit them in Configurações › Notas de
-- versão. The versions shipped with the system are copied in when the server starts (syncDefaultReleaseNotes).

-- CreateTable
CREATE TABLE "ReleaseNoteVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "notes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseNoteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseNoteVersion_version_key" ON "ReleaseNoteVersion"("version");
