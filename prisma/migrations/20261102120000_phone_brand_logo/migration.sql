-- AlterTable
ALTER TABLE "phone_brands" ADD COLUMN     "logoMediaAssetId" TEXT;

-- CreateIndex
CREATE INDEX "phone_brands_logoMediaAssetId_idx" ON "phone_brands"("logoMediaAssetId");

-- AddForeignKey
ALTER TABLE "phone_brands" ADD CONSTRAINT "phone_brands_logoMediaAssetId_fkey" FOREIGN KEY ("logoMediaAssetId") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
