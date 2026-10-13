-- Additive only: existing bundle_promotions rows get scope SPECIFIC_VARIANTS and
-- bundleSize 2, which is exactly their previous behavior. No data is rewritten.

-- CreateEnum
CREATE TYPE "BundleScope" AS ENUM ('SPECIFIC_VARIANTS', 'ALL_PRODUCTS', 'PRODUCTS', 'COLLECTIONS', 'CASE_TYPES', 'PHONE_BRANDS', 'PHONE_MODELS');

-- AlterTable
ALTER TABLE "bundle_promotions" ADD COLUMN     "bundleSize" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "scope" "BundleScope" NOT NULL DEFAULT 'SPECIFIC_VARIANTS';

-- CreateTable
CREATE TABLE "bundle_scope_targets" (
    "id" TEXT NOT NULL,
    "bundlePromotionId" TEXT NOT NULL,
    "productId" TEXT,
    "collectionId" TEXT,
    "caseTypeId" TEXT,
    "phoneBrandId" TEXT,
    "phoneModelId" TEXT,

    CONSTRAINT "bundle_scope_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bundle_scope_targets_productId_idx" ON "bundle_scope_targets"("productId");

-- CreateIndex
CREATE INDEX "bundle_scope_targets_collectionId_idx" ON "bundle_scope_targets"("collectionId");

-- CreateIndex
CREATE INDEX "bundle_scope_targets_caseTypeId_idx" ON "bundle_scope_targets"("caseTypeId");

-- CreateIndex
CREATE INDEX "bundle_scope_targets_phoneBrandId_idx" ON "bundle_scope_targets"("phoneBrandId");

-- CreateIndex
CREATE INDEX "bundle_scope_targets_phoneModelId_idx" ON "bundle_scope_targets"("phoneModelId");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_scope_targets_bundlePromotionId_productId_key" ON "bundle_scope_targets"("bundlePromotionId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_scope_targets_bundlePromotionId_collectionId_key" ON "bundle_scope_targets"("bundlePromotionId", "collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_scope_targets_bundlePromotionId_caseTypeId_key" ON "bundle_scope_targets"("bundlePromotionId", "caseTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_scope_targets_bundlePromotionId_phoneBrandId_key" ON "bundle_scope_targets"("bundlePromotionId", "phoneBrandId");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_scope_targets_bundlePromotionId_phoneModelId_key" ON "bundle_scope_targets"("bundlePromotionId", "phoneModelId");

-- AddForeignKey
ALTER TABLE "bundle_scope_targets" ADD CONSTRAINT "bundle_scope_targets_bundlePromotionId_fkey" FOREIGN KEY ("bundlePromotionId") REFERENCES "bundle_promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_scope_targets" ADD CONSTRAINT "bundle_scope_targets_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_scope_targets" ADD CONSTRAINT "bundle_scope_targets_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_scope_targets" ADD CONSTRAINT "bundle_scope_targets_caseTypeId_fkey" FOREIGN KEY ("caseTypeId") REFERENCES "case_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_scope_targets" ADD CONSTRAINT "bundle_scope_targets_phoneBrandId_fkey" FOREIGN KEY ("phoneBrandId") REFERENCES "phone_brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_scope_targets" ADD CONSTRAINT "bundle_scope_targets_phoneModelId_fkey" FOREIGN KEY ("phoneModelId") REFERENCES "phone_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Exactly one target column may be set per row (a scope target is one id).
ALTER TABLE "bundle_scope_targets" ADD CONSTRAINT "bundle_scope_targets_exactly_one_target_check"
  CHECK (num_nonnulls("productId", "collectionId", "caseTypeId", "phoneBrandId", "phoneModelId") = 1);

-- A bundle needs at least two units per instance.
ALTER TABLE "bundle_promotions" ADD CONSTRAINT "bundle_promotions_bundleSize_check" CHECK ("bundleSize" >= 2);
