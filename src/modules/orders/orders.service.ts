import { randomBytes } from 'node:crypto';
import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CartStatus,
  FulfillmentStatus,
  OrderPaymentMethod,
  PaymentStatus,
  Prisma,
  ReservationStatus,
} from '@prisma/client';
import { AppException, ResourceNotFoundException } from '../../common/exceptions/app.exception';
import { buildPaginatedResult, PaginatedResult } from '../../common/dto/paginated-result';
import { normalizePhoneNumber } from '../../common/utils/phone.util';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../auth/types/authenticated-staff.type';
import {
  CART_INCLUDE,
  CartPricingService,
  findCouponValidityError,
} from '../cart/cart-pricing.service';
import { ReservationsService } from '../inventory/reservations/reservations.service';
import { ReceiptsService } from '../payments/receipts/receipts.service';
import { computeShippingPrice, ShippingService } from '../shipping/shipping.service';
import { AdminOrderQueryDto } from './dto/admin-order-query.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { allocateDiscount, hashOrderRequestPayload } from './order-pricing.util';

const ORDER_INCLUDE = {
  items: { orderBy: { createdAt: 'asc' as const } },
  receipts: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.OrderInclude;

export type OrderWithItems = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

// See docs/BUSINESS_RULES.md for the full rationale behind each edge:
// CANCELLED is reachable from PENDING/CONFIRMED/PREPARING but never from
// SHIPPED/DELIVERED (a return process, out of scope, would be needed by
// then), and there is deliberately no direct path back out of CANCELLED.
const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  [FulfillmentStatus.PENDING]: [FulfillmentStatus.CONFIRMED, FulfillmentStatus.CANCELLED],
  [FulfillmentStatus.CONFIRMED]: [FulfillmentStatus.PREPARING, FulfillmentStatus.CANCELLED],
  [FulfillmentStatus.PREPARING]: [FulfillmentStatus.SHIPPED, FulfillmentStatus.CANCELLED],
  [FulfillmentStatus.SHIPPED]: [FulfillmentStatus.DELIVERED],
  [FulfillmentStatus.DELIVERED]: [],
  [FulfillmentStatus.CANCELLED]: [],
};

// PAID is the only state that consumes stock reservations - see
// ReservationsService.consumeManyInTransaction, called from
// updatePaymentStatus below. No code path outside a staff-authorized
// admin action ever reaches PAID (see docs/DECISIONS.md "Payment scope");
// there is no payment provider wired up yet.
const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  [PaymentStatus.UNPAID]: [PaymentStatus.PENDING, PaymentStatus.PAID, PaymentStatus.FAILED],
  [PaymentStatus.PENDING]: [PaymentStatus.PAID, PaymentStatus.FAILED],
  [PaymentStatus.FAILED]: [PaymentStatus.PENDING, PaymentStatus.PAID],
  [PaymentStatus.PAID]: [PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED],
  [PaymentStatus.PARTIALLY_REFUNDED]: [PaymentStatus.REFUNDED],
  [PaymentStatus.REFUNDED]: [],
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly pricingService: CartPricingService,
    private readonly shippingService: ShippingService,
    private readonly reservationsService: ReservationsService,
    private readonly receiptsService: ReceiptsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Creates an order from a guest cart. Every check below runs against
   * the *live* cart/catalog state, never anything cached - see
   * docs/BUSINESS_RULES.md "Checkout revalidation". The whole
   * side-effecting part (coupon usage increment, order + snapshot rows,
   * stock reservation, marking the cart ORDERED) is one Prisma
   * transaction: either the customer gets a fully-formed order with
   * reserved stock, or nothing at all changes.
   */
  async createOrder(cartId: string, dto: CreateOrderDto): Promise<OrderWithItems> {
    const { idempotencyKey, ...requestBody } = dto;
    const requestHash = hashOrderRequestPayload(requestBody);

    const existingByKey = await this.prisma.order.findUnique({
      where: { idempotencyKey },
      include: ORDER_INCLUDE,
    });
    if (existingByKey) {
      if (existingByKey.idempotencyRequestHash !== requestHash) {
        throw new AppException(
          'IDEMPOTENCY_KEY_REUSED',
          'This idempotency key was already used to place a different order request',
          HttpStatus.CONFLICT,
        );
      }
      return existingByKey;
    }

    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: CART_INCLUDE,
    });
    if (!cart) {
      throw new ResourceNotFoundException('Cart', cartId);
    }
    if (cart.status !== CartStatus.ACTIVE) {
      throw new AppException(
        'CART_ALREADY_ORDERED',
        'This cart is no longer active - it may already have been converted to an order',
        HttpStatus.CONFLICT,
      );
    }

    const priced = this.pricingService.buildView(cart);
    if (priced.items.length === 0) {
      throw new BadRequestException('Cannot check out an empty cart');
    }
    const unavailableItems = priced.items.filter((item) => !item.isAvailable);
    if (unavailableItems.length > 0) {
      throw new AppException(
        'ITEMS_UNAVAILABLE',
        'Some items in your cart are no longer available. Remove or update them and try again.',
        HttpStatus.CONFLICT,
        { items: unavailableItems },
      );
    }

    const shippingRate = await this.shippingService.resolveRateForCheckout(
      dto.shippingRateId,
      dto.shippingCountry,
    );
    const shippingTotal = computeShippingPrice(shippingRate, priced.total);
    const computedTotal = priced.total + shippingTotal;

    if (computedTotal !== dto.expectedTotal) {
      throw new AppException(
        'PRICE_CHANGED',
        'The payable total has changed since you last viewed it. Please review and confirm the new total.',
        HttpStatus.CONFLICT,
        {
          subtotal: priced.subtotal,
          discountTotal: priced.discountTotal,
          shippingTotal,
          total: computedTotal,
          currency: priced.currency,
        },
      );
    }

    if (cart.coupon) {
      const couponError = findCouponValidityError(cart.coupon, priced.subtotal);
      if (couponError) {
        throw new AppException('COUPON_NOT_APPLICABLE', couponError, HttpStatus.BAD_REQUEST);
      }
    }

    // Cash needs no proof; InstaPay requires exactly one receipt reference
    // pointing at an upload already made on this same cart (see
    // ReceiptsService.uploadForCart) - checked (ownership, not already
    // attached elsewhere, not expired) here, then re-claimed atomically
    // inside the transaction below. Uploading a screenshot never marks
    // anything PAID by itself - see docs/BUSINESS_RULES.md.
    if (dto.paymentMethod === OrderPaymentMethod.CASH_ON_DELIVERY && dto.receiptId) {
      throw new BadRequestException('receiptId must not be provided for CASH_ON_DELIVERY orders');
    }
    if (dto.paymentMethod === OrderPaymentMethod.INSTAPAY_MANUAL && !dto.receiptId) {
      throw new BadRequestException('receiptId is required for INSTAPAY_MANUAL orders');
    }
    if (dto.paymentMethod === OrderPaymentMethod.INSTAPAY_MANUAL && dto.receiptId) {
      await this.receiptsService.findOwnedUnattachedOrThrow(cartId, dto.receiptId);
    }

    const normalizedPhone = normalizePhoneNumber(dto.customerPhone, dto.shippingCountry);

    // priced.items and cart.items are index-aligned (buildView maps
    // cart.items 1:1, in order) - zip them to get bilingual snapshot
    // fields (priced.items only carries the already-localized name).
    const availableCartItems = cart.items.filter((_, index) => priced.items[index].isAvailable);
    const lineSubtotals = availableCartItems.map((item) => item.variant.price * item.quantity);
    const lineDiscounts = allocateDiscount(lineSubtotals, priced.discountTotal);

    const stockLines = availableCartItems
      .filter((item) => item.variant.stockItemId)
      .map((item) => ({
        stockItemId: item.variant.stockItemId as string,
        quantity: item.quantity,
      }));
    await this.reservationsService.sweepExpiredForStockItems([
      ...new Set(stockLines.map((line) => line.stockItemId)),
    ]);

    // InstaPay orders get a much longer stock hold than the default TTL,
    // long enough to cover the bank-transfer-and-screenshot-review window
    // rather than the short "did they abandon checkout" window cash
    // orders use - see docs/BUSINESS_RULES.md "InstaPay review deadline".
    const ttlMinutes =
      dto.paymentMethod === OrderPaymentMethod.INSTAPAY_MANUAL
        ? this.configService.getOrThrow<number>('INSTAPAY_REVIEW_DEADLINE_MINUTES')
        : this.configService.getOrThrow<number>('RESERVATION_TTL_MINUTES');

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        if (cart.coupon) {
          const couponUpdate = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
            UPDATE coupons
            SET "usageCount" = "usageCount" + 1, "updatedAt" = now()
            WHERE id = ${cart.coupon.id} AND ("usageLimit" IS NULL OR "usageCount" < "usageLimit")
            RETURNING id;
          `);
          if (couponUpdate.length === 0) {
            throw new AppException(
              'COUPON_USAGE_LIMIT_REACHED',
              'This coupon just reached its usage limit. Remove it from your cart and try again.',
              HttpStatus.CONFLICT,
            );
          }
        }

        const createdOrder = await tx.order.create({
          data: {
            trackingToken: randomBytes(32).toString('base64url'),
            idempotencyKey,
            idempotencyRequestHash: requestHash,
            cartId: cart.id,
            paymentMethod: dto.paymentMethod,
            currency: priced.currency,
            subtotal: priced.subtotal,
            discountTotal: priced.discountTotal,
            shippingTotal,
            total: computedTotal,
            couponId: cart.coupon?.id,
            couponCode: cart.coupon?.code,
            shippingRateId: shippingRate.id,
            shippingRateNameEn: shippingRate.nameEn,
            shippingRateNameAr: shippingRate.nameAr,
            customerFullName: dto.customerFullName,
            customerEmail: dto.customerEmail,
            customerPhone: normalizedPhone,
            shippingCountry: dto.shippingCountry.toUpperCase(),
            shippingCity: dto.shippingCity,
            shippingAddressLine1: dto.shippingAddressLine1,
            shippingAddressLine2: dto.shippingAddressLine2,
            shippingPostalCode: dto.shippingPostalCode,
            items: {
              create: availableCartItems.map((item, index) => ({
                variantId: item.variant.id,
                productNameEn: item.variant.product.nameEn,
                productNameAr: item.variant.product.nameAr,
                variantSku: item.variant.sku,
                phoneModelNameEn: item.variant.phoneModel?.nameEn,
                phoneModelNameAr: item.variant.phoneModel?.nameAr,
                caseTypeNameEn: item.variant.caseType?.nameEn,
                caseTypeNameAr: item.variant.caseType?.nameAr,
                unitPrice: item.variant.price,
                quantity: item.quantity,
                lineSubtotal: lineSubtotals[index],
                lineDiscount: lineDiscounts[index],
                lineTotal: lineSubtotals[index] - lineDiscounts[index],
              })),
            },
          },
          include: ORDER_INCLUDE,
        });

        if (dto.paymentMethod === OrderPaymentMethod.INSTAPAY_MANUAL && dto.receiptId) {
          await this.receiptsService.attachToOrderInTransaction(tx, dto.receiptId, createdOrder.id);
        }

        if (stockLines.length > 0) {
          await this.reservationsService.reserveManyInTransaction(tx, stockLines, {
            orderId: createdOrder.id,
            ttlMinutes,
          });
        }

        await tx.cart.update({ where: { id: cart.id }, data: { status: CartStatus.ORDERED } });

        // Re-fetch when a receipt was just attached above - `createdOrder`
        // was loaded before that attach, so its `receipts` would otherwise
        // come back empty in the response to this very request.
        if (dto.paymentMethod === OrderPaymentMethod.INSTAPAY_MANUAL && dto.receiptId) {
          return tx.order.findUniqueOrThrow({
            where: { id: createdOrder.id },
            include: ORDER_INCLUDE,
          });
        }
        return createdOrder;
      });

      await this.auditLogService.record({
        staffUserId: null,
        action: 'order.create',
        entityType: 'Order',
        entityId: order.id,
        metadata: { sequenceNumber: order.sequenceNumber, total: order.total },
      });

      return order;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A concurrent request with the same idempotency key committed
        // first - return its result instead of erroring.
        const winning = await this.prisma.order.findUnique({
          where: { idempotencyKey },
          include: ORDER_INCLUDE,
        });
        if (winning) return winning;
      }
      throw error;
    }
  }

  async findByIdForAdmin(orderId: string): Promise<OrderWithItems> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) {
      throw new ResourceNotFoundException('Order', orderId);
    }
    return order;
  }

  async findAllForAdmin(query: AdminOrderQueryDto): Promise<PaginatedResult<OrderWithItems>> {
    const where: Prisma.OrderWhereInput = {
      ...(query.fulfillmentStatus ? { fulfillmentStatus: query.fulfillmentStatus } : {}),
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
    };
    const [items, totalItems] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.order.count({ where }),
    ]);
    return buildPaginatedResult(items, totalItems, query.page, query.pageSize);
  }

  async findByTrackingToken(token: string): Promise<OrderWithItems> {
    const order = await this.prisma.order.findUnique({
      where: { trackingToken: token },
      include: ORDER_INCLUDE,
    });
    if (!order) {
      throw new AppException(
        'ORDER_NOT_FOUND',
        'No order matches this tracking link',
        HttpStatus.NOT_FOUND,
      );
    }
    return order;
  }

  /**
   * Cancellation releases any still-ACTIVE reservation (a no-op for ones
   * already consumed/expired - see ReservationsService.releaseMany) and,
   * only if payment was never confirmed, releases the coupon's usage
   * count. A CONFIRMED/PREPARING order that had already been marked PAID
   * (stock consumed) is still cancellable as a fulfillment state, but its
   * stock is deliberately NOT auto-restocked and its coupon usage is
   * deliberately NOT released - see docs/BUSINESS_RULES.md.
   */
  async updateFulfillmentStatus(
    orderId: string,
    targetStatus: FulfillmentStatus,
    actor: AuthenticatedStaff,
  ): Promise<OrderWithItems> {
    const order = await this.findByIdForAdmin(orderId);
    if (order.fulfillmentStatus === targetStatus) {
      return order;
    }
    const allowed = FULFILLMENT_TRANSITIONS[order.fulfillmentStatus] ?? [];
    if (!allowed.includes(targetStatus)) {
      throw new AppException(
        'INVALID_STATE_TRANSITION',
        `Cannot move order from ${order.fulfillmentStatus} to ${targetStatus}`,
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (targetStatus === FulfillmentStatus.CONFIRMED) {
        // Once staff have confirmed an order, its stock hold must survive
        // regardless of how long payment takes - the original checkout
        // TTL was only ever meant to protect against an abandoned,
        // never-confirmed cart. See
        // ReservationsService.pinActiveForOrderInTransaction and
        // docs/BUSINESS_RULES.md "Do not allow a confirmed order to lose
        // its stock through an unrelated timeout".
        await this.reservationsService.pinActiveForOrderInTransaction(tx, orderId);
      }

      if (targetStatus === FulfillmentStatus.CANCELLED) {
        const activeReservations = await tx.stockReservation.findMany({
          where: { orderId, status: ReservationStatus.ACTIVE },
          select: { id: true },
        });
        if (activeReservations.length > 0) {
          await this.reservationsService.releaseManyInTransaction(
            tx,
            activeReservations.map((r) => r.id),
          );
        }

        if (
          order.couponId &&
          !order.couponUsageReleased &&
          order.paymentStatus !== PaymentStatus.PAID
        ) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE coupons SET "usageCount" = GREATEST("usageCount" - 1, 0), "updatedAt" = now()
            WHERE id = ${order.couponId};
          `);
          return tx.order.update({
            where: { id: orderId },
            data: { fulfillmentStatus: targetStatus, couponUsageReleased: true },
            include: ORDER_INCLUDE,
          });
        }
      }

      return tx.order.update({
        where: { id: orderId },
        data: { fulfillmentStatus: targetStatus },
        include: ORDER_INCLUDE,
      });
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: `order.fulfillment.${targetStatus.toLowerCase()}`,
      entityType: 'Order',
      entityId: orderId,
      metadata: { from: order.fulfillmentStatus, to: targetStatus },
    });

    return updated;
  }

  /**
   * Marking PAID atomically consumes every ACTIVE reservation for this
   * order (decrementing real stock). If any reservation already expired
   * (a race between the expiry sweep and a late payment confirmation),
   * the whole transaction - including the paymentStatus write - rolls
   * back, so the order is never marked PAID while silently failing to
   * actually hold the stock. See docs/BUSINESS_RULES.md "late payment
   * after expiration".
   */
  async updatePaymentStatus(
    orderId: string,
    targetStatus: PaymentStatus,
    actor: AuthenticatedStaff,
  ): Promise<OrderWithItems> {
    const order = await this.findByIdForAdmin(orderId);
    if (order.paymentStatus === targetStatus) {
      return order;
    }
    // A CANCELLED order (including one auto-cancelled by the expiry sweep -
    // see cancelDueToExpiry) has already had its stock reservation released.
    // Without this guard, marking it PAID afterwards would "succeed" with
    // zero reservations left to consume - silently accepting payment for an
    // order that no longer holds any stock. Fulfillment and payment status
    // stay independent state machines everywhere else, but this one edge is
    // deliberately cross-checked.
    if (order.fulfillmentStatus === FulfillmentStatus.CANCELLED) {
      throw new AppException(
        'INVALID_STATE_TRANSITION',
        'Cannot change payment status on a cancelled order',
        HttpStatus.CONFLICT,
      );
    }
    const allowed = PAYMENT_TRANSITIONS[order.paymentStatus] ?? [];
    if (!allowed.includes(targetStatus)) {
      throw new AppException(
        'INVALID_STATE_TRANSITION',
        `Cannot move order payment status from ${order.paymentStatus} to ${targetStatus}`,
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (targetStatus === PaymentStatus.PAID) {
        const activeReservations = await tx.stockReservation.findMany({
          where: { orderId, status: ReservationStatus.ACTIVE },
          select: { id: true },
        });
        if (activeReservations.length > 0) {
          await this.reservationsService.consumeManyInTransaction(
            tx,
            activeReservations.map((r) => r.id),
            actor.id,
          );
        }
      }
      return tx.order.update({
        where: { id: orderId },
        data: { paymentStatus: targetStatus },
        include: ORDER_INCLUDE,
      });
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: `order.payment.${targetStatus.toLowerCase()}`,
      entityType: 'Order',
      entityId: orderId,
      metadata: { from: order.paymentStatus, to: targetStatus },
    });

    return updated;
  }

  /**
   * Called by the expiry sweep (OrderExpiryService) once an order's stock
   * reservations have already been released for expiring. Only cancels
   * orders that never progressed past PENDING/UNPAID - an order that was
   * confirmed or paid before its hold expired is never touched here, so
   * an unrelated timeout can never make a confirmed/paid order lose its
   * stock or its status. Idempotent: cancelling an already-CANCELLED (or
   * otherwise progressed) order is a silent no-op.
   */
  async cancelDueToExpiry(orderId: string): Promise<boolean> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return false;
    if (
      order.fulfillmentStatus !== FulfillmentStatus.PENDING ||
      order.paymentStatus !== PaymentStatus.UNPAID
    ) {
      return false;
    }

    await this.prisma.$transaction(async (tx) => {
      if (order.couponId && !order.couponUsageReleased) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE coupons SET "usageCount" = GREATEST("usageCount" - 1, 0), "updatedAt" = now()
          WHERE id = ${order.couponId};
        `);
      }
      await tx.order.updateMany({
        where: {
          id: orderId,
          fulfillmentStatus: FulfillmentStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
        },
        data: {
          fulfillmentStatus: FulfillmentStatus.CANCELLED,
          couponUsageReleased: order.couponId ? true : order.couponUsageReleased,
        },
      });
    });

    await this.auditLogService.record({
      staffUserId: null,
      action: 'order.fulfillment.cancelled_expired',
      entityType: 'Order',
      entityId: orderId,
      metadata: { reason: 'stock_reservation_expired' },
    });
    return true;
  }

  /**
   * Records that payment was discovered for an order that is already
   * CANCELLED (e.g. a late InstaPay transfer that arrived after the
   * review deadline expired and the reservation/order were auto-
   * cancelled) - deliberately does NOT change fulfillmentStatus or
   * paymentStatus, and does NOT re-reserve stock. This is purely an
   * audited note for a human to reconcile manually (refund the transfer,
   * or fulfil out-of-band if stock genuinely allows it) - see
   * docs/BUSINESS_RULES.md "Late payment after cancellation".
   */
  async flagLatePayment(
    orderId: string,
    note: string,
    actor: AuthenticatedStaff,
  ): Promise<OrderWithItems> {
    const order = await this.findByIdForAdmin(orderId);
    if (order.fulfillmentStatus !== FulfillmentStatus.CANCELLED) {
      throw new AppException(
        'INVALID_STATE_TRANSITION',
        'Late-payment reconciliation only applies to a cancelled order',
        HttpStatus.CONFLICT,
      );
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { latePaymentFlaggedAt: new Date(), latePaymentNote: note },
      include: ORDER_INCLUDE,
    });

    await this.auditLogService.record({
      staffUserId: actor.id,
      action: 'order.late_payment_flagged',
      entityType: 'Order',
      entityId: orderId,
      metadata: { note },
    });

    return updated;
  }
}
