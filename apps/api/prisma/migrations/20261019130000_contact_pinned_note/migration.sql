-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "pinnedNote" TEXT,
ADD COLUMN     "pinnedNoteUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "pinnedNoteUpdatedBy" TEXT;

