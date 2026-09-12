-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "bundleDiscount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "bundleInstanceId" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "bundleDiscountTotal" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "bundle_promotions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fixedTotal" INTEGER,
    "currency" TEXT,
    "requireDifferentPhoneModels" BOOLEAN NOT NULL DEFAULT true,
    "isRepeatable" BOOLEAN NOT NULL DEFAULT true,
    "allowCouponStacking" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bundle_promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_eligible_variants" (
    "id" TEXT NOT NULL,
    "bundlePromotionId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "surchargeAmount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bundle_eligible_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_instances" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "bundlePromotionId" TEXT NOT NULL,
    "fixedTotalApplied" INTEGER NOT NULL,
    "normalSubtotal" INTEGER NOT NULL,
    "discountAmount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bundle_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bundle_eligible_variants_variantId_idx" ON "bundle_eligible_variants"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_eligible_variants_bundlePromotionId_variantId_key" ON "bundle_eligible_variants"("bundlePromotionId", "variantId");

-- CreateIndex
CREATE INDEX "bundle_instances_orderId_idx" ON "bundle_instances"("orderId");

-- CreateIndex
CREATE INDEX "bundle_instances_bundlePromotionId_idx" ON "bundle_instances"("bundlePromotionId");

-- CreateIndex
CREATE INDEX "order_items_bundleInstanceId_idx" ON "order_items"("bundleInstanceId");

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_bundleInstanceId_fkey" FOREIGN KEY ("bundleInstanceId") REFERENCES "bundle_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_eligible_variants" ADD CONSTRAINT "bundle_eligible_variants_bundlePromotionId_fkey" FOREIGN KEY ("bundlePromotionId") REFERENCES "bundle_promotions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_eligible_variants" ADD CONSTRAINT "bundle_eligible_variants_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_instances" ADD CONSTRAINT "bundle_instances_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_instances" ADD CONSTRAINT "bundle_instances_bundlePromotionId_fkey" FOREIGN KEY ("bundlePromotionId") REFERENCES "bundle_promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
