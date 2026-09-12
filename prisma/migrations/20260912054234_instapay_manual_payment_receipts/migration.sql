-- CreateEnum
CREATE TYPE "OrderPaymentMethod" AS ENUM ('CASH_ON_DELIVERY', 'INSTAPAY_MANUAL');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING_REVIEW', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "latePaymentFlaggedAt" TIMESTAMP(3),
ADD COLUMN     "latePaymentNote" TEXT,
ADD COLUMN     "paymentMethod" "OrderPaymentMethod" NOT NULL DEFAULT 'CASH_ON_DELIVERY';

-- CreateTable
CREATE TABLE "payment_receipts" (
    "id" TEXT NOT NULL,
    "cartId" TEXT NOT NULL,
    "orderId" TEXT,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "rejectionReason" TEXT,
    "reviewedByStaffId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_receipts_cartId_idx" ON "payment_receipts"("cartId");

-- CreateIndex
CREATE INDEX "payment_receipts_orderId_idx" ON "payment_receipts"("orderId");

-- CreateIndex
CREATE INDEX "payment_receipts_expiresAt_idx" ON "payment_receipts"("expiresAt");

-- AddForeignKey
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_reviewedByStaffId_fkey" FOREIGN KEY ("reviewedByStaffId") REFERENCES "staff_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
