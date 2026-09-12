-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "reservationDeadline" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "orders_fulfillmentStatus_paymentStatus_reservationDeadline_idx" ON "orders"("fulfillmentStatus", "paymentStatus", "reservationDeadline");
