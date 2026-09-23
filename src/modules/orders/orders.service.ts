import { randomBytes } from 'node:crypto';
import { BadRequestException, HttpStatus, Injectable, Logger } from '@nestjs/common';
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
  effectiveUnitPrice,
  findCouponValidityError,
} from '../cart/cart-pricing.service';
import { ReservationsService } from '../inventory/reservations/reservations.service';
import { ReceiptsService } from '../payments/receipts/receipts.service';
import {
  BundleSourceLine,
  computeBundleInstances,
} from '../promotions/bundles/bundle-pricing.util';
import { BundlesService } from '../promotions/bundles/bundles.service';
import { computeShippingPrice, ShippingService } from '../shipping/shipping.service';
import { AdminOrderQueryDto } from './dto/admin-order-query.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { allocateDiscount, hashOrderRequestPayload } from './order-pricing.util';

const ORDER_INCLUDE = {
  items: {
    include: {
      returns: { orderBy: { createdAt: 'asc' as const } },
      customDesign: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
  receipts: { orderBy: { createdAt: 'asc' as const } },
  refunds: { orderBy: { createdAt: 'asc' as const } },
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
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly pricingService: CartPricingService,
    private readonly shippingService: ShippingService,
    private readonly reservationsService: ReservationsService,
    private readonly receiptsService: ReceiptsService,
    private readonly bundlesService: BundlesService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Creates an order from a guest cart. Every check that actually decides
   * what gets persisted runs INSIDE the transaction, against freshly
   * tx-read state - never a pre-transaction snapshot - so a concurrent
   * price/stock/coupon change, or a second simultaneous checkout attempt
   * on the same cart, can never sneak an order through with stale numbers
   * or create a duplicate. See docs/BUSINESS_RULES.md "Checkout
   * revalidation" and docs/DECISIONS.md for the race this closes.
   */
  async createOrder(cartId: string, dto: CreateOrderDto): Promise<OrderWithItems> {
    const { idempotencyKey, ...requestBody } = dto;
    const requestHash = hashOrderRequestPayload(requestBody);

    // Idempotency is scoped to the cart that is replaying it - a key
    // collision from a DIFFERENT cart (a client bug, or a guess/reuse
    // attempt) must never hand back somebody else's order, even if the
    // request bodies happen to match byte-for-byte.
    const existingByKey = await this.prisma.order.findUnique({
      where: { idempotencyKey },
      include: ORDER_INCLUDE,
    });
    if (existingByKey) {
      if (existingByKey.cartId !== cartId || existingByKey.idempotencyRequestHash !== requestHash) {
        throw new AppException(
          'IDEMPOTENCY_KEY_REUSED',
          'This idempotency key is already in use',
          HttpStatus.CONFLICT,
        );
      }
      return existingByKey;
    }

    // Cheap, cart-independent structural checks - fail fast without
    // opening a transaction for an obviously malformed request.
    if (dto.paymentMethod === OrderPaymentMethod.CASH_ON_DELIVERY && dto.receiptId) {
      throw new BadRequestException('receiptId must not be provided for CASH_ON_DELIVERY orders');
    }
    if (dto.paymentMethod === OrderPaymentMethod.INSTAPAY_MANUAL && !dto.receiptId) {
      throw new BadRequestException('receiptId is required for INSTAPAY_MANUAL orders');
    }
    // Fast, friendly fail for the common case (garbage/foreign/expired
    // receiptId) - NOT what enforces correctness under concurrency; the
    // authoritative recheck is attachToOrderInTransaction's own
    // conditional UPDATE, done fresh inside the transaction below.
    if (dto.paymentMethod === OrderPaymentMethod.INSTAPAY_MANUAL && dto.receiptId) {
      try {
        await this.receiptsService.findOwnedUnattachedOrThrow(cartId, dto.receiptId);
      } catch (error) {
        // A concurrent, byte-for-byte identical retry (same cart, same
        // idempotency key, same payload, including this same receiptId)
        // may have already committed in the gap since the initial
        // idempotencyKey lookup above - its order creation would have
        // attached this exact receipt, which this fast pre-check would
        // otherwise misreport as RECEIPT_ALREADY_ATTACHED instead of
        // recognizing it as this request's own already-completed result.
        if (error instanceof AppException && error.code === 'RECEIPT_ALREADY_ATTACHED') {
          const existingOrder = await this.prisma.order.findUnique({
            where: { cartId },
            include: ORDER_INCLUDE,
          });
          if (
            existingOrder &&
            existingOrder.idempotencyKey === idempotencyKey &&
            existingOrder.idempotencyRequestHash === requestHash
          ) {
            return existingOrder;
          }
        }
        throw error;
      }
    }

    const normalizedPhone = normalizePhoneNumber(dto.customerPhone, dto.shippingCountry);

    // InstaPay orders get a long review deadline; COD orders get none by
    // default - a submitted COD order is real (a courier is expected to
    // collect payment on delivery) and must not inherit the short
    // abandoned-checkout timeout meant for an unconfirmed hold. Both the
    // per-stock-item reservation TTL and the order-level auto-cancel
    // deadline are derived from this one value, computed once, so they
    // can never drift apart. See docs/BUSINESS_RULES.md.
    const ttlMinutes: number | null =
      dto.paymentMethod === OrderPaymentMethod.INSTAPAY_MANUAL
        ? this.configService.getOrThrow<number>('INSTAPAY_REVIEW_DEADLINE_MINUTES')
        : (this.configService.get<number>('COD_EXPIRY_MINUTES') ?? null);
    const reservationDeadline =
      ttlMinutes === null ? null : new Date(Date.now() + ttlMinutes * 60_000);

    try {
      const order = await this.prisma.$transaction(async (tx) => {
        // Atomically claim the cart - this conditional UPDATE is the
        // actual concurrency gate that makes "one cart produces at most
        // one order" hold: only one concurrent transaction can ever match
        // a cart still ACTIVE (Postgres's row lock serializes the second
        // one behind the first), so a simultaneous second checkout
        // attempt on the same cart is guaranteed to see it already
        // ORDERED and roll back cleanly instead of creating a duplicate.
        const claimed = await tx.cart.updateMany({
          where: { id: cartId, status: CartStatus.ACTIVE },
          data: { status: CartStatus.ORDERED },
        });
        if (claimed.count === 0) {
          const existingCart = await tx.cart.findUnique({ where: { id: cartId } });
          if (!existingCart) {
            throw new ResourceNotFoundException('Cart', cartId);
          }

          // The cart may have lost this race to a SIMULTANEOUS retry of
          // this exact request (same cart, same idempotency key, same
          // payload) rather than a genuinely different checkout attempt.
          // Postgres's row lock on the cart guarantees the transaction
          // that actually won the claim above has FULLY COMMITTED by the
          // time our own conditional UPDATE's WHERE clause could stop
          // matching - so if it was truly our own retry, its order is
          // already visible here (Order.cartId is unique, so there is at
          // most one). Returning it instead of CART_ALREADY_ORDERED is
          // what makes concurrent identical retries idempotent, not just
          // sequential ones - see docs/BUSINESS_RULES.md.
          const existingOrderForCart = await tx.order.findUnique({
            where: { cartId },
            include: ORDER_INCLUDE,
          });
          if (existingOrderForCart && existingOrderForCart.idempotencyKey === idempotencyKey) {
            if (existingOrderForCart.idempotencyRequestHash === requestHash) {
              return existingOrderForCart;
            }
            throw new AppException(
              'IDEMPOTENCY_KEY_REUSED',
              'This idempotency key is already in use',
              HttpStatus.CONFLICT,
            );
          }

          throw new AppException(
            'CART_ALREADY_ORDERED',
            'This cart is no longer active - it may already have been converted to an order',
            HttpStatus.CONFLICT,
          );
        }

        // Everything from here on reads FRESH, transactionally-consistent
        // state - never a pre-transaction snapshot.
        const cart = await tx.cart.findUnique({ where: { id: cartId }, include: CART_INCLUDE });
        if (!cart) {
          throw new ResourceNotFoundException('Cart', cartId);
        }

        const activeBundles = await this.bundlesService.findActiveForPricingInTransaction(tx);
        const priced = this.pricingService.buildView(cart, undefined, activeBundles);
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

        // priced.items and cart.items are index-aligned (buildView maps
        // cart.items 1:1, in order) - zip them to get bilingual snapshot
        // fields (priced.items only carries the already-localized name).
        const availableCartItems = cart.items.filter((_, index) => priced.items[index].isAvailable);

        // Recomputed independently (rather than reusing `priced`'s
        // internal result) because we need the actual instance-level
        // groupings to persist as BundleInstance rows - but it is
        // guaranteed to agree exactly with `priced.bundleDiscountTotal`:
        // same pure function, same `activeBundles`, same units in the
        // same order (buildView filters cart.items to available ones
        // preserving order, exactly like `availableCartItems` here).
        const couponIsApplied = Boolean(cart.coupon) && !priced.couponWarning;
        const bundleSourceLines: BundleSourceLine[] = availableCartItems.map((item, lineIndex) => ({
          lineIndex,
          variantId: item.variant.id,
          phoneModelId: item.variant.phoneModelId,
          unitPrice: effectiveUnitPrice(item.variant),
          quantity: item.quantity,
          currency: item.variant.currency,
        }));
        const bundleInstances = computeBundleInstances(bundleSourceLines, activeBundles, {
          couponIsApplied,
        });

        // Aggregate per (line, bundle instance) unit counts/discounts - a
        // single cart line can have some units bundled and others not (or
        // even units split across two different bundle instances when the
        // promotion is repeatable), so it may need to become more than one
        // OrderItem row. See docs/BUSINESS_RULES.md.
        const usageByLine = new Map<number, Map<number, { quantity: number; discount: number }>>();
        bundleInstances.forEach((instance, instanceIndex) => {
          for (const allocation of instance.unitAllocations) {
            const lineUsage =
              usageByLine.get(allocation.lineIndex) ??
              new Map<number, { quantity: number; discount: number }>();
            const existing = lineUsage.get(instanceIndex) ?? { quantity: 0, discount: 0 };
            existing.quantity += 1;
            existing.discount += allocation.discount;
            lineUsage.set(instanceIndex, existing);
            usageByLine.set(allocation.lineIndex, lineUsage);
          }
        });

        interface OrderItemDraft {
          item: (typeof availableCartItems)[number];
          quantity: number;
          bundleInstanceIndex: number | null;
          bundleDiscount: number;
        }
        const drafts: OrderItemDraft[] = [];
        availableCartItems.forEach((item, lineIndex) => {
          const lineUsage = usageByLine.get(lineIndex);
          let usedQuantity = 0;
          if (lineUsage) {
            for (const [instanceIndex, usage] of lineUsage) {
              drafts.push({
                item,
                quantity: usage.quantity,
                bundleInstanceIndex: instanceIndex,
                bundleDiscount: usage.discount,
              });
              usedQuantity += usage.quantity;
            }
          }
          const remaining = item.quantity - usedQuantity;
          if (remaining > 0) {
            drafts.push({
              item,
              quantity: remaining,
              bundleInstanceIndex: null,
              bundleDiscount: 0,
            });
          }
        });

        const draftSubtotals = drafts.map(
          (draft) => effectiveUnitPrice(draft.item.variant) * draft.quantity,
        );
        // Allocated against each draft's REMAINING amount after its own
        // bundle discount, not its raw subtotal - otherwise a heavily
        // bundle-discounted line could receive a further, proportional-
        // to-full-price coupon share that pushes its own lineTotal
        // negative even though the cart-level total stays non-negative.
        // Since allocateDiscount never lets any single allocation exceed
        // the corresponding input, and priced.discountTotal was itself
        // computed against subtotal - bundleDiscountTotal (see
        // CartPricingService.buildView), this guarantees
        // couponDiscount[i] + bundleDiscount[i] <= draftSubtotals[i] for
        // every line - see docs/BUSINESS_RULES.md and docs/DECISIONS.md.
        const draftEligibleForCoupon = drafts.map(
          (draft, index) => draftSubtotals[index] - draft.bundleDiscount,
        );
        const draftCouponDiscounts = allocateDiscount(draftEligibleForCoupon, priced.discountTotal);

        const stockLines = availableCartItems
          .filter((item) => item.variant.stockItemId)
          .map((item) => ({
            stockItemId: item.variant.stockItemId as string,
            quantity: item.quantity,
          }));

        const createdOrder = await tx.order.create({
          data: {
            trackingToken: randomBytes(32).toString('base64url'),
            idempotencyKey,
            idempotencyRequestHash: requestHash,
            cartId: cart.id,
            paymentMethod: dto.paymentMethod,
            reservationDeadline,
            currency: priced.currency,
            subtotal: priced.subtotal,
            discountTotal: priced.discountTotal,
            bundleDiscountTotal: priced.bundleDiscountTotal,
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
          },
        });

        // Created after the order (BundleInstance.orderId is required) and
        // before the OrderItems that reference them, sequentially, so each
        // instance's real DB id is known deterministically by array index
        // - no ambiguous re-matching of created rows back to instances.
        const bundleInstanceDbIds: string[] = [];
        for (const instance of bundleInstances) {
          const created = await tx.bundleInstance.create({
            data: {
              orderId: createdOrder.id,
              bundlePromotionId: instance.bundlePromotionId,
              fixedTotalApplied: instance.fixedTotalApplied,
              normalSubtotal: instance.normalSubtotal,
              discountAmount: instance.discountAmount,
            },
          });
          bundleInstanceDbIds.push(created.id);
        }

        // Individual `create` calls (not `createMany`) because a
        // personalized draft needs the real, newly-created OrderItem id
        // to write its OrderItemCustomDesign snapshot row right after -
        // order sizes here are always small (a handful of lines), so this
        // costs nothing meaningful over a bulk insert.
        for (let index = 0; index < drafts.length; index += 1) {
          const draft = drafts[index];
          const { item, quantity } = draft;
          const lineSubtotal = draftSubtotals[index];
          const lineDiscount = draftCouponDiscounts[index];
          const customizationPrice = item.variant.isPersonalizable
            ? item.variant.customizationPrice
            : 0;

          const createdItem = await tx.orderItem.create({
            data: {
              orderId: createdOrder.id,
              variantId: item.variant.id,
              productNameEn: item.variant.product.nameEn,
              productNameAr: item.variant.product.nameAr,
              variantSku: item.variant.sku,
              phoneModelNameEn: item.variant.phoneModel?.nameEn,
              phoneModelNameAr: item.variant.phoneModel?.nameAr,
              caseTypeNameEn: item.variant.caseType?.nameEn,
              caseTypeNameAr: item.variant.caseType?.nameAr,
              note: item.note,
              unitPrice: effectiveUnitPrice(item.variant),
              customizationPrice,
              quantity,
              lineSubtotal,
              lineDiscount,
              bundleInstanceId:
                draft.bundleInstanceIndex !== null
                  ? bundleInstanceDbIds[draft.bundleInstanceIndex]
                  : null,
              bundleDiscount: draft.bundleDiscount,
              lineTotal: lineSubtotal - lineDiscount - draft.bundleDiscount,
            },
          });

          // Immutable copy of the cart line's design, made now so the
          // order keeps its own original/print-ready/preview files even if
          // the source CustomDesign is later replaced/detached on the cart
          // - see OrderItemCustomDesign in prisma/schema.prisma. A single
          // cart line split across two drafts (bundle pairing) gets the
          // SAME design copied onto both resulting OrderItem rows, exactly
          // like every other snapshot field here (productNameEn etc).
          if (item.customDesign) {
            const design = item.customDesign;
            await tx.orderItemCustomDesign.create({
              data: {
                orderItemId: createdItem.id,
                sourceCustomDesignId: design.id,
                originalStorageKey: design.originalStorageKey,
                originalMimeType: design.originalMimeType,
                originalSizeBytes: design.originalSizeBytes,
                originalWidth: design.originalWidth,
                originalHeight: design.originalHeight,
                printFileStorageKey: design.printFileStorageKey,
                printFileMimeType: design.printFileMimeType,
                printFileSizeBytes: design.printFileSizeBytes,
                previewStorageKey: design.previewStorageKey,
                previewMimeType: design.previewMimeType,
                previewSizeBytes: design.previewSizeBytes,
                fitMode: design.fitMode,
                printWidthPx: design.printWidthPx,
                printHeightPx: design.printHeightPx,
                printDpi: design.printDpi,
                printSafeMarginPx: design.printSafeMarginPx,
                printOutputFormat: design.printOutputFormat,
                printOutputQuality: design.printOutputQuality,
                designCreatedAt: design.createdAt,
              },
            });
          }
        }

        if (dto.paymentMethod === OrderPaymentMethod.INSTAPAY_MANUAL && dto.receiptId) {
          await this.receiptsService.attachToOrderInTransaction(
            tx,
            cartId,
            dto.receiptId,
            createdOrder.id,
          );
        }

        if (stockLines.length > 0) {
          await this.reservationsService.reserveManyInTransaction(tx, stockLines, {
            orderId: createdOrder.id,
            ttlMinutes,
          });
        }

        return tx.order.findUniqueOrThrow({
          where: { id: createdOrder.id },
          include: ORDER_INCLUDE,
        });
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
        // first - identical validation to the normal lookup path above:
        // only return it if it truly belongs to this cart and payload,
        // never hand back an order this request didn't earn.
        const winning = await this.prisma.order.findUnique({
          where: { idempotencyKey },
          include: ORDER_INCLUDE,
        });
        if (
          winning &&
          winning.cartId === cartId &&
          winning.idempotencyRequestHash === requestHash
        ) {
          return winning;
        }
        throw new AppException(
          'IDEMPOTENCY_KEY_REUSED',
          'This idempotency key is already in use',
          HttpStatus.CONFLICT,
        );
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
   * Acquires a row-level lock on the order (`SELECT ... FOR UPDATE`) for
   * the remainder of the enclosing transaction, BEFORE reading anything
   * else about it, then returns the fully fresh, post-lock row. This is
   * the single, consistent serialization point every operation that can
   * change an order's fulfillmentStatus/paymentStatus (confirm, cancel,
   * mark paid, expire) now acquires FIRST, before any validation - see
   * docs/BUSINESS_RULES.md and docs/DECISIONS.md for the race this
   * closes. Without it, two concurrent operations that each guard only
   * their OWN column (fulfillmentStatus vs paymentStatus) in the final
   * write can both "win" against a STALE pre-transaction read of the
   * order, producing a contradictory combination (e.g. an order that
   * ends up both CANCELLED and PAID) - most dangerously for
   * isUnlimitedStock orders, which have no StockReservation row to
   * provide any incidental locking of their own the way tracked-stock
   * orders accidentally had. `RefundsService.recordRefund` locks the same
   * way, so every writer of order.fulfillmentStatus/paymentStatus shares
   * one consistent lock order: the order row first, always. Returns
   * `null` (never throws) if the order does not exist, so callers decide
   * how to react (a hard 404 for an admin action, a silent skip for the
   * best-effort expiry sweep).
   */
  private async lockOrderForUpdate(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<OrderWithItems | null> {
    await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE;
    `);
    return tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
  }

  /**
   * Cancellation releases any still-ACTIVE reservation (a no-op for ones
   * already consumed/expired - see ReservationsService.releaseMany) and,
   * only if payment was never confirmed, releases the coupon's usage
   * count. A CONFIRMED/PREPARING order that had already been marked PAID
   * (stock consumed) is still cancellable as a fulfillment state, but its
   * stock is deliberately NOT auto-restocked and its coupon usage is
   * deliberately NOT released - see docs/BUSINESS_RULES.md.
   *
   * Every read that decides what happens here - the current status, the
   * payment method/status cross-checks, the reservation triage - happens
   * AFTER `lockOrderForUpdate` acquires the row lock, never from a
   * pre-transaction snapshot. A concurrent `updatePaymentStatus` call on
   * the same order fully serializes behind whichever of the two acquires
   * the lock first, so it is impossible for this call and a competing
   * payment confirmation to both apply their side effects from stale,
   * mutually-contradictory assumptions about the order's state - see
   * docs/DECISIONS.md for the race this closes and why the previous
   * guarded-`updateMany`-only approach was not sufficient on its own (kept
   * here too, now purely as a defensive belt-and-suspenders check that
   * should never actually fire in practice).
   */
  async updateFulfillmentStatus(
    orderId: string,
    targetStatus: FulfillmentStatus,
    actor: AuthenticatedStaff,
  ): Promise<OrderWithItems> {
    let previousStatus: FulfillmentStatus | undefined;
    let isNoOp = false;

    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrderForUpdate(tx, orderId);
      if (!order) {
        throw new ResourceNotFoundException('Order', orderId);
      }
      previousStatus = order.fulfillmentStatus;

      if (order.fulfillmentStatus === targetStatus) {
        isNoOp = true;
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
      // InstaPay must be paid before it ships; COD is fulfillable
      // regardless of payment status since payment is collected on
      // delivery. Reads `order.paymentStatus` as locked/fresh above, so a
      // payment confirmation that only just committed is never missed.
      if (
        targetStatus === FulfillmentStatus.PREPARING &&
        order.paymentMethod === OrderPaymentMethod.INSTAPAY_MANUAL &&
        order.paymentStatus !== PaymentStatus.PAID
      ) {
        throw new AppException(
          'PAYMENT_NOT_CONFIRMED',
          'This InstaPay order cannot move to preparation before its payment is confirmed',
          HttpStatus.CONFLICT,
        );
      }

      let couponReleaseNeeded = false;

      if (targetStatus === FulfillmentStatus.CONFIRMED) {
        // Once staff have confirmed an order, its stock hold must survive
        // regardless of how long payment takes. Refuse to confirm a
        // tracked-stock order whose reservation is no longer active
        // (expired/released between checkout and this action) - that
        // would confirm a commitment the business can no longer actually
        // keep. An order with no reservation at all (isUnlimitedStock
        // items only) is unaffected - see docs/BUSINESS_RULES.md.
        const triage = await this.loadReservationTriage(tx, orderId);
        this.assertStockCommitmentNotLost(triage, 'confirm this order');
        if (triage.active.length > 0) {
          await this.reservationsService.pinActiveForOrderInTransaction(tx, orderId);
        }
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
        // Reads the FRESH, just-locked `order.paymentStatus` - if a
        // competing payment confirmation won the lock first and already
        // committed PAID, this correctly sees PAID and does NOT release
        // coupon usage for an order that is, in fact, paid - never a
        // stale UNPAID snapshot read before this transaction acquired the
        // lock. This is what "legitimate paid-order cancellation" and
        // "never release paid-order coupon usage using stale unpaid
        // state" both come down to. Refunded states also represent a
        // previously paid order and must retain coupon usage.
        // See docs/BUSINESS_RULES.md.
        couponReleaseNeeded = Boolean(
          order.couponId &&
          !order.couponUsageReleased &&
          (order.paymentStatus === PaymentStatus.UNPAID ||
            order.paymentStatus === PaymentStatus.PENDING ||
            order.paymentStatus === PaymentStatus.FAILED),
        );
      }

      const result = await tx.order.updateMany({
        where: { id: orderId, fulfillmentStatus: order.fulfillmentStatus },
        data: {
          fulfillmentStatus: targetStatus,
          ...(couponReleaseNeeded ? { couponUsageReleased: true } : {}),
        },
      });
      if (result.count === 0) {
        // Cannot actually happen while every writer of fulfillmentStatus
        // goes through lockOrderForUpdate first - kept as a defensive
        // guard, not the primary protection, in case a future code path
        // ever mutates this order without acquiring the lock.
        throw new AppException(
          'ORDER_STATE_CHANGED',
          'This order was changed by another request - reload and try again',
          HttpStatus.CONFLICT,
        );
      }

      if (couponReleaseNeeded) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE coupons SET "usageCount" = GREATEST("usageCount" - 1, 0), "updatedAt" = now()
          WHERE id = ${order.couponId};
        `);
      }

      return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
    });

    if (!isNoOp) {
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: `order.fulfillment.${targetStatus.toLowerCase()}`,
        entityType: 'Order',
        entityId: orderId,
        metadata: { from: previousStatus, to: targetStatus },
      });
    }

    return updated;
  }

  /**
   * Marking PAID atomically consumes every ACTIVE reservation for this
   * order (decrementing real stock) and, for InstaPay, accepts whichever
   * receipt is currently pending review in the same transaction - "the
   * order is paid" and "its proof was accepted" are one atomic action,
   * never two independent writes that could disagree. If the order had
   * tracked-stock items but none of their reservations are still active
   * (expired, or otherwise lost - as opposed to an isUnlimitedStock order,
   * which never had any reservation to begin with), this refuses to mark
   * it paid rather than silently accepting payment for stock the business
   * no longer actually holds - see docs/BUSINESS_RULES.md "late payment
   * after expiration". Locks the order row first (`lockOrderForUpdate`),
   * exactly like updateFulfillmentStatus/cancelDueToExpiry, so this and a
   * concurrent cancellation/expiry on the same order fully serialize
   * instead of racing against each other's stale pre-transaction reads.
   */
  async updatePaymentStatus(
    orderId: string,
    targetStatus: PaymentStatus,
    actor: AuthenticatedStaff,
  ): Promise<OrderWithItems> {
    // Refund states must always be DERIVED from a recorded Refund (amount,
    // reason, staff actor, idempotency) - see RefundsService.recordRefund
    // and docs/BUSINESS_RULES.md. This generic status endpoint is refused
    // for both targets so there is exactly one path that can ever produce
    // them, and it can never bypass the over-refund cap.
    if (
      targetStatus === PaymentStatus.PARTIALLY_REFUNDED ||
      targetStatus === PaymentStatus.REFUNDED
    ) {
      throw new AppException(
        'USE_REFUNDS_ENDPOINT',
        'Refund status changes must go through POST /admin/orders/:id/refunds, which records the refund that justifies them',
        HttpStatus.BAD_REQUEST,
      );
    }

    let previousStatus: PaymentStatus | undefined;
    let isNoOp = false;

    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrderForUpdate(tx, orderId);
      if (!order) {
        throw new ResourceNotFoundException('Order', orderId);
      }
      previousStatus = order.paymentStatus;

      if (order.paymentStatus === targetStatus) {
        isNoOp = true;
        return order;
      }
      // A CANCELLED order (including one auto-cancelled by the expiry
      // sweep - see cancelDueToExpiry) has already had its stock
      // reservation released. Without this guard, marking it PAID
      // afterwards would "succeed" with zero reservations left to
      // consume - silently accepting payment for an order that no longer
      // holds any stock. Fulfillment and payment status stay independent
      // state machines everywhere else, but this one edge is
      // deliberately cross-checked - and, reading `order.fulfillmentStatus`
      // fresh from the just-acquired lock, a cancellation that only just
      // committed (by a concurrent request) is never missed here.
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

      if (targetStatus === PaymentStatus.PAID) {
        const triage = await this.loadReservationTriage(tx, orderId);
        this.assertStockCommitmentNotLost(triage, 'mark this order paid');
        if (triage.active.length > 0) {
          await this.reservationsService.consumeManyInTransaction(tx, triage.active, actor.id);
        }
        if (order.paymentMethod === OrderPaymentMethod.INSTAPAY_MANUAL) {
          await this.receiptsService.acceptPendingReceiptInTransaction(tx, orderId, actor.id);
        }
      }

      const result = await tx.order.updateMany({
        where: { id: orderId, paymentStatus: order.paymentStatus },
        data: { paymentStatus: targetStatus },
      });
      if (result.count === 0) {
        // Cannot actually happen while every writer of paymentStatus goes
        // through lockOrderForUpdate first - kept as a defensive guard,
        // not the primary protection. See updateFulfillmentStatus.
        throw new AppException(
          'ORDER_STATE_CHANGED',
          'This order was changed by another request - reload and try again',
          HttpStatus.CONFLICT,
        );
      }

      return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
    });

    if (!isNoOp) {
      await this.auditLogService.record({
        staffUserId: actor.id,
        action: `order.payment.${targetStatus.toLowerCase()}`,
        entityType: 'Order',
        entityId: orderId,
        metadata: { from: previousStatus, to: targetStatus },
      });
    }

    return updated;
  }

  /**
   * Every ACTIVE/CONSUMED/other reservation for an order, triaged once so
   * callers can tell "this order never had tracked stock at all"
   * (isUnlimitedStock items only - `hasAny: false`) apart from "this
   * order's stock commitment is incomplete" (`hasAny: true, fullyCovered:
   * false`). Used by both the CONFIRMED and PAID transitions, which must
   * refuse the latter but proceed normally for the former and for a
   * legitimately-already-consumed order (e.g. a second PAID-adjacent
   * action after stock was already consumed once).
   *
   * `fullyCovered` is computed by AGGREGATING every reservation row by
   * `stockItemId`: the "required" quantity for a stock item is the sum of
   * every reservation ever created against it for this order (a stable
   * snapshot fixed at order-creation time - `reserveManyInTransaction`
   * aggregates all cart lines that share a stock item into one
   * reservation, so this is deliberately NOT re-derived from any
   * variant's CURRENT `stockItemId`, which can be reassigned by staff
   * after the order was placed), and the "covered" quantity is the sum of
   * only its ACTIVE or CONSUMED reservations. An order is only
   * `fullyCovered` when EVERY required stock item's covered quantity
   * meets its required quantity. This is what fixes the previous "one
   * ACTIVE reservation masks another EXPIRED one" gap: an order needing
   * two different stock items, where only one still has coverage, used
   * to pass because `active.length > 0` was true - it now correctly
   * fails because the OTHER stock item's requirement is not covered. See
   * docs/BUSINESS_RULES.md and docs/DECISIONS.md.
   */
  private async loadReservationTriage(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<{ active: string[]; hasAny: boolean; hasConsumed: boolean; fullyCovered: boolean }> {
    // Callers already hold the order lock. Lock its reservations before
    // reading coverage: standalone/lazy expiry does not lock the order.
    // These locks survive through pin/consume and transaction commit, so
    // expiry either finishes before this check or sees the pinned/consumed
    // state afterwards. Stable ordering avoids competing lock orders here.
    await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM stock_reservations
      WHERE "orderId" = ${orderId}
      ORDER BY id FOR UPDATE;
    `);
    const all = await tx.stockReservation.findMany({
      where: { orderId },
      select: { id: true, status: true, stockItemId: true, quantity: true },
    });

    const requiredByStockItem = new Map<string, number>();
    const coveredByStockItem = new Map<string, number>();
    for (const reservation of all) {
      requiredByStockItem.set(
        reservation.stockItemId,
        (requiredByStockItem.get(reservation.stockItemId) ?? 0) + reservation.quantity,
      );
      if (
        reservation.status === ReservationStatus.ACTIVE ||
        reservation.status === ReservationStatus.CONSUMED
      ) {
        coveredByStockItem.set(
          reservation.stockItemId,
          (coveredByStockItem.get(reservation.stockItemId) ?? 0) + reservation.quantity,
        );
      }
    }
    let fullyCovered = true;
    for (const [stockItemId, requiredQuantity] of requiredByStockItem) {
      if ((coveredByStockItem.get(stockItemId) ?? 0) < requiredQuantity) {
        fullyCovered = false;
        break;
      }
    }

    return {
      active: all.filter((r) => r.status === ReservationStatus.ACTIVE).map((r) => r.id),
      hasAny: all.length > 0,
      hasConsumed: all.some((r) => r.status === ReservationStatus.CONSUMED),
      fullyCovered,
    };
  }

  private assertStockCommitmentNotLost(
    triage: { hasAny: boolean; fullyCovered: boolean },
    action: string,
  ): void {
    if (triage.hasAny && !triage.fullyCovered) {
      throw new AppException(
        'STOCK_RESERVATION_LOST',
        `Cannot ${action} - its stock reservation is no longer active (expired or released) and ` +
          'requires manual review before proceeding',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * Cancels one order because its own `reservationDeadline` passed while
   * still PENDING/UNPAID - fully self-contained and safe to call
   * repeatedly (a scheduler tick, a manual trigger, or a retry after a
   * previous attempt failed). Locks the order row first
   * (`lockOrderForUpdate`), exactly like updateFulfillmentStatus/
   * updatePaymentStatus, so this and a concurrent payment confirmation or
   * manual cancellation on the same order fully serialize rather than
   * racing on stale reads; reservation release and coupon-usage release
   * only ever happen INSIDE the same transaction AFTER the guarded write
   * succeeds, so a lost race can never partially apply one side effect
   * without the other, and a subsequent call for the same order always
   * re-evaluates fresh state rather than silently giving up. See
   * docs/DECISIONS.md for the bug this replaced (coupon usage could be
   * decremented before confirming cancellation actually won) and the
   * later fix that made this safe against a concurrent PAID transition
   * too, not just a concurrent cancellation.
   */
  async cancelDueToExpiry(orderId: string): Promise<boolean> {
    // Fast, non-authoritative pre-filter so the sweep (which can call
    // this for hundreds of candidates per tick) doesn't open a
    // transaction for an order that obviously no longer qualifies - NEVER
    // what decides correctness; the lock + fresh read inside the
    // transaction below is authoritative, exactly like every other
    // mutator of order.fulfillmentStatus/paymentStatus.
    const precheck = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { fulfillmentStatus: true, paymentStatus: true },
    });
    if (!precheck) return false;
    if (
      precheck.fulfillmentStatus !== FulfillmentStatus.PENDING ||
      precheck.paymentStatus !== PaymentStatus.UNPAID
    ) {
      return false;
    }

    const cancelled = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrderForUpdate(tx, orderId);
      if (!order) return false;
      // Re-validated against the FRESH, just-locked row - a concurrent
      // payment confirmation or manual cancellation that committed in the
      // gap since the pre-check above is never missed here.
      if (
        order.fulfillmentStatus !== FulfillmentStatus.PENDING ||
        order.paymentStatus !== PaymentStatus.UNPAID
      ) {
        return false;
      }

      const result = await tx.order.updateMany({
        where: {
          id: orderId,
          fulfillmentStatus: FulfillmentStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
        },
        data: {
          fulfillmentStatus: FulfillmentStatus.CANCELLED,
          ...(order.couponId ? { couponUsageReleased: true } : {}),
        },
      });
      if (result.count === 0) {
        // Defensive only - cannot actually happen once the lock above has
        // already been acquired and re-validated against fresh data.
        return false;
      }

      const activeReservations = await tx.stockReservation.findMany({
        where: { orderId, status: ReservationStatus.ACTIVE },
        select: { id: true },
      });
      if (activeReservations.length > 0) {
        await this.reservationsService.releaseManyInTransaction(
          tx,
          activeReservations.map((r) => r.id),
          ReservationStatus.EXPIRED,
        );
      }

      if (order.couponId && !order.couponUsageReleased) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE coupons SET "usageCount" = GREATEST("usageCount" - 1, 0), "updatedAt" = now()
          WHERE id = ${order.couponId};
        `);
      }

      return true;
    });

    if (cancelled) {
      await this.auditLogService.record({
        staffUserId: null,
        action: 'order.fulfillment.cancelled_expired',
        entityType: 'Order',
        entityId: orderId,
        metadata: { reason: 'reservation_deadline_passed' },
      });
    }
    return cancelled;
  }

  /**
   * Order-level expiry sweep: queries orders directly by their own
   * `reservationDeadline`, independent of whether any StockReservation
   * exists (an isUnlimitedStock-only order has none) or what happened to
   * one that did (a lazy per-stock-item release elsewhere never needs to
   * "know" to trigger this - the order's own deadline drives it on the
   * next call regardless). This is also what makes a previously-failed
   * cancellation retry-safe: an order that didn't actually cancel last
   * time is simply found again by this same query next time, since
   * nothing about it changed. See docs/BUSINESS_RULES.md.
   */
  async cancelExpiredOrders(limit = 200): Promise<number> {
    const candidates = await this.prisma.order.findMany({
      where: {
        fulfillmentStatus: FulfillmentStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        reservationDeadline: { not: null, lt: new Date() },
      },
      select: { id: true },
      take: limit,
    });

    let cancelled = 0;
    for (const { id } of candidates) {
      try {
        if (await this.cancelDueToExpiry(id)) cancelled += 1;
      } catch (error) {
        // One order's cancellation failing must not stop the others, and
        // must not be lost - the next sweep re-queries and retries it,
        // since cancelDueToExpiry is idempotent and this order will still
        // match the candidate query above until it actually cancels.
        this.logger.error(
          `Failed to cancel expired order ${id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
    return cancelled;
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
