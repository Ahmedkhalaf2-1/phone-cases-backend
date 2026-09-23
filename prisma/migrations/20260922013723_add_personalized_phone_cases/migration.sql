-- CreateEnum
CREATE TYPE "PrintOutputFormat" AS ENUM ('JPEG', 'PNG');

-- CreateEnum
CREATE TYPE "CustomDesignFitMode" AS ENUM ('CENTER_CROP_COVER');

-- DropIndex
DROP INDEX "cart_items_cartId_variantId_key";

-- AlterTable
ALTER TABLE "cart_items" ADD COLUMN     "customDesignId" TEXT,
ADD COLUMN     "isPersonalized" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "customizationPrice" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "customizationPrice" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "isPersonalizable" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "print_specifications" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "widthPx" INTEGER NOT NULL,
    "heightPx" INTEGER NOT NULL,
    "dpi" INTEGER NOT NULL DEFAULT 300,
    "safeMarginPx" INTEGER,
    "outputFormat" "PrintOutputFormat" NOT NULL DEFAULT 'JPEG',
    "outputQuality" INTEGER NOT NULL DEFAULT 92,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "print_specifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_designs" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "originalStorageKey" TEXT NOT NULL,
    "originalMimeType" TEXT NOT NULL,
    "originalSizeBytes" INTEGER NOT NULL,
    "originalWidth" INTEGER NOT NULL,
    "originalHeight" INTEGER NOT NULL,
    "printFileStorageKey" TEXT NOT NULL,
    "printFileMimeType" TEXT NOT NULL,
    "printFileSizeBytes" INTEGER NOT NULL,
    "previewStorageKey" TEXT NOT NULL,
    "previewMimeType" TEXT NOT NULL,
    "previewSizeBytes" INTEGER NOT NULL,
    "fitMode" "CustomDesignFitMode" NOT NULL DEFAULT 'CENTER_CROP_COVER',
    "printWidthPx" INTEGER NOT NULL,
    "printHeightPx" INTEGER NOT NULL,
    "printDpi" INTEGER NOT NULL,
    "printSafeMarginPx" INTEGER,
    "printOutputFormat" "PrintOutputFormat" NOT NULL,
    "printOutputQuality" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_designs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_custom_designs" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "sourceCustomDesignId" TEXT,
    "originalStorageKey" TEXT NOT NULL,
    "originalMimeType" TEXT NOT NULL,
    "originalSizeBytes" INTEGER NOT NULL,
    "originalWidth" INTEGER NOT NULL,
    "originalHeight" INTEGER NOT NULL,
    "printFileStorageKey" TEXT NOT NULL,
    "printFileMimeType" TEXT NOT NULL,
    "printFileSizeBytes" INTEGER NOT NULL,
    "previewStorageKey" TEXT NOT NULL,
    "previewMimeType" TEXT NOT NULL,
    "previewSizeBytes" INTEGER NOT NULL,
    "fitMode" "CustomDesignFitMode" NOT NULL,
    "printWidthPx" INTEGER NOT NULL,
    "printHeightPx" INTEGER NOT NULL,
    "printDpi" INTEGER NOT NULL,
    "printSafeMarginPx" INTEGER,
    "printOutputFormat" "PrintOutputFormat" NOT NULL,
    "printOutputQuality" INTEGER NOT NULL,
    "designCreatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_item_custom_designs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "print_specifications_variantId_key" ON "print_specifications"("variantId");

-- CreateIndex
CREATE INDEX "custom_designs_cartId_idx" ON "custom_designs"("cartId");

-- CreateIndex
CREATE INDEX "custom_designs_variantId_idx" ON "custom_designs"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "order_item_custom_designs_orderItemId_key" ON "order_item_custom_designs"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_customDesignId_key" ON "cart_items"("customDesignId");

-- CreateIndex
CREATE INDEX "cart_items_cartId_variantId_idx" ON "cart_items"("cartId", "variantId");

-- PartialUniqueIndex: replaces the old plain UNIQUE(cartId, variantId).
-- A NON-personalized line still merges by (cartId, variantId) - see
-- CartService.addItem - but a personalizable variant legitimately needs
-- many lines per cart, one per uploaded design, so the constraint only
-- applies when isPersonalized is false. Hand-written (Prisma's schema DSL
-- cannot express a partial index) - see prisma/schema.prisma's CartItem
-- model comment and docs/DECISIONS.md.
CREATE UNIQUE INDEX "cart_items_cart_variant_non_personalized_key" ON "cart_items"("cartId", "variantId") WHERE NOT "isPersonalized";

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_customDesignId_fkey" FOREIGN KEY ("customDesignId") REFERENCES "custom_designs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_specifications" ADD CONSTRAINT "print_specifications_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_designs" ADD CONSTRAINT "custom_designs_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_designs" ADD CONSTRAINT "custom_designs_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_custom_designs" ADD CONSTRAINT "order_item_custom_designs_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_custom_designs" ADD CONSTRAINT "order_item_custom_designs_sourceCustomDesignId_fkey" FOREIGN KEY ("sourceCustomDesignId") REFERENCES "custom_designs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
