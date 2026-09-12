import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { OrderItemReturn, PaymentStatus, Prisma, Refund } from '@prisma/client';
import { AppException, ResourceNotFoundException } from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { CreateOrderItemReturnDto } from './dto/create-order-item-return.dto';
import { CreateRefundDto } from './dto/create-refund.dto';

interface OrderRow {
  id: string;
  total: number;
  currency: string;
  paymentStatus: PaymentStatus;
}

@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Records that money was manually sent back to a customer OUTSIDE this
   * system (bank transfer, InstaPay, cash) - this never moves money
   * itself. `Order.paymentStatus` is then derived from the running total
   * of every Refund row for the order, never set directly - this is the
   * ONLY path that can produce PARTIALLY_REFUNDED/REFUNDED (see
   * OrdersService.updatePaymentStatus, which refuses both as a direct
   * target). A `SELECT ... FOR UPDATE` row lock on the order serializes
   * concurrent refund attempts on the same order so the
   * sum(refunds) <= order.total invariant can never be broken by a race
   * between two simultaneous requests - see docs/BUSINESS_RULES.md.
   */
  async recordRefund(
    orderId: string,
    dto: CreateRefundDto,
    actor: AuthenticatedStaff,
  ): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<OrderRow[]>(Prisma.sql`
        SELECT id, total, currency, "paymentStatus" FROM orders WHERE id = ${orderId} FOR UPDATE;
      `);
      const order = rows[0];
      if (!order) {
        throw new ResourceNotFoundException('Order', orderId);
      }

      // Checked BEFORE any state-transition validity check: a retried
      // request for a refund that has already been fully recorded (and may
      // have already moved the order past PAID/PARTIALLY_REFUNDED, e.g. to
      // REFUNDED) must still replay as a no-op, not fail as if the retry
      // were a brand new, now-illegal request.
      const existing = await tx.refund.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        if (existing.orderId !== orderId) {
          throw new AppException(
            'IDEMPOTENCY_KEY_REUSED',
            'This idempotency key is already in use for a different order',
            HttpStatus.CONFLICT,
          );
        }
        return existing;
      }

      if (
        order.paymentStatus !== PaymentStatus.PAID &&
        order.paymentStatus !== PaymentStatus.PARTIALLY_REFUNDED
      ) {
        throw new AppException(
          'INVALID_STATE_TRANSITION',
          `Cannot refund an order with payment status ${order.paymentStatus} - it must be PAID or PARTIALLY_REFUNDED`,
          HttpStatus.CONFLICT,
        );
      }
      if (dto.currency !== order.currency) {
        throw new BadRequestException(
          `Refund currency (${dto.currency}) must match the order currency (${order.currency})`,
        );
      }

      const aggregate = await tx.refund.aggregate({ where: { orderId }, _sum: { amount: true } });
      const alreadyRefunded = aggregate._sum.amount ?? 0;
      const newTotal = alreadyRefunded + dto.amount;
      if (newTotal > order.total) {
        throw new AppException(
          'REFUND_EXCEEDS_PAID_AMOUNT',
          `This refund would bring total refunds to ${newTotal}, exceeding the ${order.total} actually paid for this order (already refunded: ${alreadyRefunded})`,
          HttpStatus.CONFLICT,
        );
      }

      const refund = await tx.refund.create({
        data: {
          orderId,
          amount: dto.amount,
          currency: dto.currency,
          reason: dto.reason,
          staffUserId: actor.id,
          idempotencyKey: dto.idempotencyKey,
        },
      });

      const newPaymentStatus =
        newTotal >= order.total ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
      await tx.order.update({ where: { id: orderId }, data: { paymentStatus: newPaymentStatus } });

      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'order.refund.recorded',
        entityType: 'Order',
        entityId: orderId,
        metadata: {
          amount: dto.amount,
          currency: dto.currency,
          reason: dto.reason,
          newPaymentStatus,
        },
      });

      return refund;
    });
  }

  async findRefundsForOrder(orderId: string): Promise<Refund[]> {
    await this.assertOrderExists(orderId);
    return this.prisma.refund.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' } });
  }

  /**
   * Records that physical goods came back for one order line. Deliberately
   * does NOT touch StockItem.onHand - see OrderItemReturn's schema comment
   * and docs/BUSINESS_RULES.md: restocking is a separate, explicit staff
   * decision (StockItemsService.adjust), since a returned item might be
   * damaged and never sellable again.
   */
  async recordItemReturn(
    orderId: string,
    orderItemId: string,
    dto: CreateOrderItemReturnDto,
    actor: AuthenticatedStaff,
  ): Promise<OrderItemReturn> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; quantity: number; orderId: string }[]
      >(Prisma.sql`
        SELECT id, quantity, "orderId" FROM order_items WHERE id = ${orderItemId} FOR UPDATE;
      `);
      const orderItem = rows[0];
      if (!orderItem || orderItem.orderId !== orderId) {
        throw new ResourceNotFoundException('OrderItem', orderItemId);
      }

      const aggregate = await tx.orderItemReturn.aggregate({
        where: { orderItemId },
        _sum: { quantity: true },
      });
      const alreadyReturned = aggregate._sum.quantity ?? 0;
      if (alreadyReturned + dto.quantity > orderItem.quantity) {
        throw new AppException(
          'RETURN_EXCEEDS_PURCHASED_QUANTITY',
          `This return would bring total returned quantity to ${alreadyReturned + dto.quantity}, exceeding the ${orderItem.quantity} units on this line (already returned: ${alreadyReturned})`,
          HttpStatus.CONFLICT,
        );
      }

      const created = await tx.orderItemReturn.create({
        data: {
          orderItemId,
          quantity: dto.quantity,
          reason: dto.reason,
          staffUserId: actor.id,
        },
      });

      await this.auditLogService.record({
        staffUserId: actor.id,
        action: 'order_item.return.recorded',
        entityType: 'OrderItem',
        entityId: orderItemId,
        metadata: { quantity: dto.quantity, reason: dto.reason },
      });

      return created;
    });
  }

  async findReturnsForOrderItem(orderId: string, orderItemId: string): Promise<OrderItemReturn[]> {
    const orderItem = await this.prisma.orderItem.findUnique({ where: { id: orderItemId } });
    if (!orderItem || orderItem.orderId !== orderId) {
      throw new ResourceNotFoundException('OrderItem', orderItemId);
    }
    return this.prisma.orderItemReturn.findMany({
      where: { orderItemId },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async assertOrderExists(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new ResourceNotFoundException('Order', orderId);
    }
  }
}
