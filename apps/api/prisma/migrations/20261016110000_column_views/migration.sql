-- CreateTable
CREATE TABLE "ColumnView" (
    "id" TEXT NOT NULL,
    "screen" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "ownerId" TEXT NOT NULL,
    "shareAll" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ColumnView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ColumnViewShares" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "ColumnView_screen_idx" ON "ColumnView"("screen");

-- CreateIndex
CREATE UNIQUE INDEX "ColumnView_ownerId_screen_key" ON "ColumnView"("ownerId", "screen");

-- CreateIndex
CREATE UNIQUE INDEX "_ColumnViewShares_AB_unique" ON "_ColumnViewShares"("A", "B");

-- CreateIndex
CREATE INDEX "_ColumnViewShares_B_index" ON "_ColumnViewShares"("B");

-- AddForeignKey
ALTER TABLE "ColumnView" ADD CONSTRAINT "ColumnView_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ColumnViewShares" ADD CONSTRAINT "_ColumnViewShares_A_fkey" FOREIGN KEY ("A") REFERENCES "ColumnView"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ColumnViewShares" ADD CONSTRAINT "_ColumnViewShares_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

