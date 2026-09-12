-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "isUnlimitedStock" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "stock_reservations" ALTER COLUMN "expiresAt" DROP NOT NULL;
