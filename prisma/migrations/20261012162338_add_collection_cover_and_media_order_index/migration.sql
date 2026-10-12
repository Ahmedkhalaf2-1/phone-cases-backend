-- AlterTable
ALTER TABLE "collections" ADD COLUMN     "coverMediaAssetId" TEXT;

-- CreateIndex
CREATE INDEX "collections_coverMediaAssetId_idx" ON "collections"("coverMediaAssetId");

-- CreateIndex
CREATE INDEX "product_media_productId_displayOrder_idx" ON "product_media"("productId", "displayOrder");

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_coverMediaAssetId_fkey" FOREIGN KEY ("coverMediaAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
