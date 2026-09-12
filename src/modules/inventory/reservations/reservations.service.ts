import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ReservationStatus, StockReservation } from '@prisma/client';
import {
  InsufficientStockException,
  InvalidStateTransitionException,
  ResourceNotFoundException,
} from '../../../common/exceptions/app.exception';
import { PrismaService } from '../../../prisma/prisma.service';

const DEFAULT_RESERVATION_TTL_MINUTES = 15;

export interface ReserveInput {
  stockItemId: string;
  quantity: number;
  cartId?: string;
  orderId?: string;
  // undefined -> use DEFAULT_RESERVATION_TTL_MINUTES; null -> never expires
  // (e.g. a CASH_ON_DELIVERY order with no configured COD_EXPIRY_MINUTES -
  // see OrdersService.createOrder). Explicitly distinct from `undefined` -
  // `??` would treat both the same and silently reinstate a default TTL
  // for a caller that deliberately asked for "no expiry".
  ttlMinutes?: number | null;
}

function resolveExpiresAt(ttlMinutes: number | null | undefined): Date | null {
  if (ttlMinutes === null) return null;
  const minutes = ttlMinutes ?? DEFAULT_RESERVATION_TTL_MINUTES;
  return new Date(Date.now() + minutes * 60_000);
}

// Raw-query RETURNING clause for stock_reservations, aliased back to the
// camelCase columns Prisma's client uses everywhere else (see
// src/prisma/prisma.service.ts for why these columns are camelCase, not
// snake_case, in the first place).
const RESERVATION_RETURNING = Prisma.sql`
  RETURNING
    id, "stockItemId", "cartId", "orderId", quantity, status,
    "expiresAt", "releasedAt", "consumedAt", "createdAt", "updatedAt"
`;

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Places a time-limited hold against a stock item's available quantity
   * (onHand - reserved). Safe under concurrency: the increment to
   * `reserved` and the availability check happen in one conditional SQL
   * UPDATE, not a read-then-write. Expired holds on this stock item are
   * swept first so they never block a legitimate new reservation just
   * because no background job has run yet (see ReservationExpiryScheduler
   * for the actual background sweep; this lazy sweep is a correctness
   * backstop, not a substitute for it).
   */
  async reserve(input: ReserveInput): Promise<StockReservation> {
    await this.releaseExpiredForStockItem(input.stockItemId);

    const expiresAt = resolveExpiresAt(input.ttlMinutes);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE stock_items
        SET reserved = reserved + ${input.quantity}, "updatedAt" = now()
        WHERE id = ${input.stockItemId} AND "onHand" - reserved >= ${input.quantity}
        RETURNING id;
      `);

      if (updated.length === 0) {
        throw new InsufficientStockException(input.stockItemId, input.quantity);
      }

      return tx.stockReservation.create({
        data: {
          stockItemId: input.stockItemId,
          quantity: input.quantity,
          cartId: input.cartId,
          orderId: input.orderId,
          expiresAt,
        },
      });
    });
  }

  /**
   * Reserves several stock items at once, atomically: either every line
   * succeeds or none do (a single DB transaction - if any conditional
   * UPDATE affects zero rows, the whole transaction throws and rolls
   * back, so no partial holds are ever left behind). Quantities for
   * repeated `stockItemId`s are aggregated first, so e.g. two different
   * cart lines (two different print-on-demand designs) that both consume
   * the same blank StockItem reserve their combined quantity as a single
   * atomic check against that one counter, not two independent checks
   * that could individually pass while together overselling it.
   */
  async reserveMany(
    lines: { stockItemId: string; quantity: number }[],
    options: { cartId?: string; orderId?: string; ttlMinutes?: number | null } = {},
  ): Promise<StockReservation[]> {
    const aggregated = this.aggregateLines(lines);
    await this.sweepExpiredForStockItems([...aggregated.keys()]);

    return this.prisma.$transaction((tx) =>
      this.reserveAggregatedInTransaction(tx, aggregated, options),
    );
  }

  /**
   * Same aggregation/atomicity guarantee as `reserveMany`, but composed
   * into a transaction the *caller* already owns (see OrdersService,
   * which needs order creation, coupon-usage increment and stock
   * reservation to all commit or roll back together as one unit). The
   * caller is responsible for sweeping expired reservations on the
   * relevant stock items beforehand (`sweepExpiredForStockItems`) -
   * Prisma's interactive-transaction client can't itself start a nested
   * transaction to do that lazily mid-flight the way `reserveMany` does.
   */
  async reserveManyInTransaction(
    tx: Prisma.TransactionClient,
    lines: { stockItemId: string; quantity: number }[],
    options: { cartId?: string; orderId?: string; ttlMinutes?: number | null } = {},
  ): Promise<StockReservation[]> {
    return this.reserveAggregatedInTransaction(tx, this.aggregateLines(lines), options);
  }

  /** Releases any expired ACTIVE reservations on the given stock items. */
  async sweepExpiredForStockItems(stockItemIds: string[]): Promise<void> {
    for (const stockItemId of stockItemIds) {
      await this.releaseExpiredForStockItem(stockItemId);
    }
  }

  private aggregateLines(lines: { stockItemId: string; quantity: number }[]): Map<string, number> {
    const aggregated = new Map<string, number>();
    for (const line of lines) {
      aggregated.set(line.stockItemId, (aggregated.get(line.stockItemId) ?? 0) + line.quantity);
    }
    return aggregated;
  }

  private async reserveAggregatedInTransaction(
    tx: Prisma.TransactionClient,
    aggregated: Map<string, number>,
    options: { cartId?: string; orderId?: string; ttlMinutes?: number | null },
  ): Promise<StockReservation[]> {
    const expiresAt = resolveExpiresAt(options.ttlMinutes);

    const created: StockReservation[] = [];
    for (const [stockItemId, quantity] of aggregated) {
      const updated = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE stock_items
        SET reserved = reserved + ${quantity}, "updatedAt" = now()
        WHERE id = ${stockItemId} AND "onHand" - reserved >= ${quantity}
        RETURNING id;
      `);
      if (updated.length === 0) {
        throw new InsufficientStockException(stockItemId, quantity);
      }
      created.push(
        await tx.stockReservation.create({
          data: {
            stockItemId,
            quantity,
            cartId: options.cartId,
            orderId: options.orderId,
            expiresAt,
          },
        }),
      );
    }
    return created;
  }

  /**
   * Releases an ACTIVE reservation without consuming stock (cart
   * abandoned, item removed, checkout failed, or expiry). Idempotent:
   * releasing an already-released/expired/consumed reservation is a
   * no-op that returns the reservation as-is rather than erroring.
   *
   * The status transition itself is the atomic guard - `UPDATE ... WHERE
   * status = 'ACTIVE'` - rather than a separate read-then-branch, so two
   * concurrent callers (e.g. the expiry sweep and a manual cancellation)
   * racing on the same reservation can never both believe they were the
   * one that released it: whichever UPDATE's WHERE clause commits first
   * wins, and Postgres's row lock makes the second one see the already-
   * updated status and affect zero rows.
   */
  async release(
    reservationId: string,
    status: 'RELEASED' | 'EXPIRED' = ReservationStatus.RELEASED,
  ): Promise<StockReservation> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<StockReservation[]>(Prisma.sql`
        UPDATE stock_reservations
        SET status = ${status}::"ReservationStatus", "releasedAt" = now(), "updatedAt" = now()
        WHERE id = ${reservationId} AND status = 'ACTIVE'
        ${RESERVATION_RETURNING};
      `);

      if (rows.length === 0) {
        const existing = await tx.stockReservation.findUnique({ where: { id: reservationId } });
        if (!existing) {
          throw new ResourceNotFoundException('StockReservation', reservationId);
        }
        return existing;
      }

      const reservation = rows[0];
      await tx.$executeRaw(Prisma.sql`
        UPDATE stock_items
        SET reserved = reserved - ${reservation.quantity}, "updatedAt" = now()
        WHERE id = ${reservation.stockItemId} AND reserved >= ${reservation.quantity};
      `);

      return reservation;
    });
  }

  /**
   * Commits a reservation: decrements real onHand stock and records a
   * StockMovement. Called when a staff member records payment as
   * received (OrdersService.updatePaymentStatus) - there is no payment
   * provider wired up yet (Phase 4), so nothing calls this from a
   * webhook or client-facing endpoint.
   *
   * Like `release`, the ACTIVE -> CONSUMED transition is the atomic
   * guard. If the reservation already expired (e.g. the expiry sweep won
   * a race against a late payment confirmation), this throws rather than
   * silently consuming stock that may already have been sold to someone
   * else - see docs/BUSINESS_RULES.md "late payment after expiration".
   */
  async consume(reservationId: string, staffUserId?: string): Promise<StockReservation> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<StockReservation[]>(Prisma.sql`
        UPDATE stock_reservations
        SET status = 'CONSUMED', "consumedAt" = now(), "updatedAt" = now()
        WHERE id = ${reservationId} AND status = 'ACTIVE'
        ${RESERVATION_RETURNING};
      `);

      if (rows.length === 0) {
        const existing = await tx.stockReservation.findUnique({ where: { id: reservationId } });
        if (!existing) {
          throw new ResourceNotFoundException('StockReservation', reservationId);
        }
        throw new InvalidStateTransitionException(
          `Reservation is ${existing.status}, it can no longer be consumed - the stock hold may ` +
            'have expired before payment was confirmed. This requires manual review: check ' +
            'current stock, and either restock/re-reserve or contact the customer.',
        );
      }

      const reservation = rows[0];
      const updatedStock = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE stock_items
        SET "onHand" = "onHand" - ${reservation.quantity},
            reserved = reserved - ${reservation.quantity},
            "updatedAt" = now()
        WHERE id = ${reservation.stockItemId}
          AND "onHand" >= ${reservation.quantity}
          AND reserved >= ${reservation.quantity}
        RETURNING id;
      `);

      if (updatedStock.length === 0) {
        throw new InvalidStateTransitionException(
          'Stock item counters are inconsistent with this reservation - refusing to consume',
        );
      }

      await tx.stockMovement.create({
        data: {
          stockItemId: reservation.stockItemId,
          delta: -reservation.quantity,
          reason: 'reservation_consumed',
          referenceType: 'StockReservation',
          referenceId: reservation.id,
          staffUserId,
        },
      });

      return reservation;
    });
  }

  /**
   * Consumes every reservation for one order atomically: either all of
   * them commit (onHand decremented, StockMovement recorded for each) or
   * none do. Used when a staff member records a payment as received
   * (OrdersService.updatePaymentStatus) - an order can have more than one
   * reservation (one per distinct StockItem across its lines), and a
   * partial consume would leave stock in a state that doesn't match the
   * order's own paid status.
   */
  async consumeMany(reservationIds: string[], staffUserId?: string): Promise<StockReservation[]> {
    if (reservationIds.length === 0) return [];
    return this.prisma.$transaction((tx) =>
      this.consumeManyInTransaction(tx, reservationIds, staffUserId),
    );
  }

  /**
   * Same as `consumeMany`, composed into a transaction the caller already
   * owns (see OrdersService.updatePaymentStatus, which needs the
   * paymentStatus write and every reservation's consumption to commit or
   * roll back together).
   */
  async consumeManyInTransaction(
    tx: Prisma.TransactionClient,
    reservationIds: string[],
    staffUserId?: string,
  ): Promise<StockReservation[]> {
    const consumed: StockReservation[] = [];
    for (const reservationId of reservationIds) {
      const rows = await tx.$queryRaw<StockReservation[]>(Prisma.sql`
        UPDATE stock_reservations
        SET status = 'CONSUMED', "consumedAt" = now(), "updatedAt" = now()
        WHERE id = ${reservationId} AND status = 'ACTIVE'
        ${RESERVATION_RETURNING};
      `);

      if (rows.length === 0) {
        const existing = await tx.stockReservation.findUnique({ where: { id: reservationId } });
        throw new InvalidStateTransitionException(
          existing
            ? `Reservation ${reservationId} is ${existing.status}, it can no longer be consumed - ` +
                'the stock hold may have expired before payment was confirmed. This requires manual ' +
                'review: check current stock, and either restock/re-reserve or contact the customer.'
            : `Reservation ${reservationId} was not found`,
        );
      }

      const reservation = rows[0];
      const updatedStock = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE stock_items
        SET "onHand" = "onHand" - ${reservation.quantity},
            reserved = reserved - ${reservation.quantity},
            "updatedAt" = now()
        WHERE id = ${reservation.stockItemId}
          AND "onHand" >= ${reservation.quantity}
          AND reserved >= ${reservation.quantity}
        RETURNING id;
      `);
      if (updatedStock.length === 0) {
        throw new InvalidStateTransitionException(
          `Stock item counters are inconsistent with reservation ${reservationId} - refusing to consume`,
        );
      }

      await tx.stockMovement.create({
        data: {
          stockItemId: reservation.stockItemId,
          delta: -reservation.quantity,
          reason: 'reservation_consumed',
          referenceType: 'StockReservation',
          referenceId: reservation.id,
          staffUserId,
        },
      });

      consumed.push(reservation);
    }
    return consumed;
  }

  /**
   * Releases every reservation for one order atomically (all-or-nothing).
   * Used on order cancellation - see OrdersService.updateFulfillmentStatus.
   * Already-non-ACTIVE reservations in the list are left as-is (same
   * idempotent behavior as `release`), so cancelling an order some of
   * whose reservations already expired/were consumed is still safe.
   */
  async releaseMany(
    reservationIds: string[],
    status: 'RELEASED' | 'EXPIRED' = ReservationStatus.RELEASED,
  ): Promise<StockReservation[]> {
    if (reservationIds.length === 0) return [];
    return this.prisma.$transaction((tx) =>
      this.releaseManyInTransaction(tx, reservationIds, status),
    );
  }

  /**
   * Same as `releaseMany`, composed into a transaction the caller already
   * owns (see OrdersService.updateFulfillmentStatus, which releases
   * reservations and updates the order's status, and possibly the
   * coupon's usage count, as one atomic unit).
   */
  async releaseManyInTransaction(
    tx: Prisma.TransactionClient,
    reservationIds: string[],
    status: 'RELEASED' | 'EXPIRED' = ReservationStatus.RELEASED,
  ): Promise<StockReservation[]> {
    const released: StockReservation[] = [];
    for (const reservationId of reservationIds) {
      const rows = await tx.$queryRaw<StockReservation[]>(Prisma.sql`
        UPDATE stock_reservations
        SET status = ${status}::"ReservationStatus", "releasedAt" = now(), "updatedAt" = now()
        WHERE id = ${reservationId} AND status = 'ACTIVE'
        ${RESERVATION_RETURNING};
      `);

      if (rows.length === 0) {
        const existing = await tx.stockReservation.findUnique({ where: { id: reservationId } });
        if (existing) released.push(existing);
        continue;
      }

      const reservation = rows[0];
      await tx.$executeRaw(Prisma.sql`
        UPDATE stock_items
        SET reserved = reserved - ${reservation.quantity}, "updatedAt" = now()
        WHERE id = ${reservation.stockItemId} AND reserved >= ${reservation.quantity};
      `);
      released.push(reservation);
    }
    return released;
  }

  /**
   * Releases a reservation for expiry ONLY IF it is still actually expired
   * at the moment of the write, not just at the moment it was selected -
   * `release()`'s own guard (`status = 'ACTIVE'`) is not enough here on its
   * own: between a sweep's SELECT and this UPDATE, the reservation could
   * have been pinned (`expiresAt` set to NULL on order confirmation) by a
   * concurrent request - pinning never changes `status`, so a plain
   * `release()` call would still match and incorrectly expire a
   * now-permanent hold. Baking the expiry recheck into the same
   * conditional UPDATE closes that race: if the row no longer matches
   * (pinned, already resolved, or simply not expired anymore), this
   * affects zero rows and returns null instead of forcing a release.
   */
  private async releaseIfStillExpired(reservationId: string): Promise<StockReservation | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<StockReservation[]>(Prisma.sql`
        UPDATE stock_reservations
        SET status = 'EXPIRED', "releasedAt" = now(), "updatedAt" = now()
        WHERE id = ${reservationId}
          AND status = 'ACTIVE'
          AND "expiresAt" IS NOT NULL
          AND "expiresAt" < now()
        ${RESERVATION_RETURNING};
      `);
      if (rows.length === 0) {
        return null;
      }
      const reservation = rows[0];
      await tx.$executeRaw(Prisma.sql`
        UPDATE stock_items
        SET reserved = reserved - ${reservation.quantity}, "updatedAt" = now()
        WHERE id = ${reservation.stockItemId} AND reserved >= ${reservation.quantity};
      `);
      return reservation;
    });
  }

  /**
   * Releases every expired ACTIVE reservation, bounded to `limit` per
   * call so a scheduled sweep (ReservationExpiryScheduler) never does
   * unbounded work in one tick. Returns only reservations *actually*
   * transitioned by this call (see `releaseIfStillExpired`) - a row that
   * lost the race (pinned, or resolved some other way between selection
   * and release) is silently skipped rather than counted, so sweep counts
   * always reflect real transitions.
   *
   * `expiresAt: null` (see pinActiveForOrderInTransaction) means "does not
   * expire" - such a reservation can never match the selection query, by
   * construction, regardless of how much wall-clock time passes. There is
   * no separate "is this order confirmed?" branch needed here.
   */
  async releaseAllExpired(limit = 200): Promise<StockReservation[]> {
    const candidates = await this.prisma.stockReservation.findMany({
      where: {
        status: ReservationStatus.ACTIVE,
        expiresAt: { not: null, lt: new Date() },
      },
      select: { id: true },
      take: limit,
    });
    const released: StockReservation[] = [];
    for (const { id } of candidates) {
      const reservation = await this.releaseIfStillExpired(id);
      if (reservation) released.push(reservation);
    }
    if (released.length > 0) {
      this.logger.log(`Released ${released.length} expired stock reservation(s)`);
    }
    return released;
  }

  private async releaseExpiredForStockItem(stockItemId: string): Promise<void> {
    const candidates = await this.prisma.stockReservation.findMany({
      where: {
        stockItemId,
        status: ReservationStatus.ACTIVE,
        expiresAt: { not: null, lt: new Date() },
      },
      select: { id: true },
    });
    for (const { id } of candidates) {
      await this.releaseIfStillExpired(id);
    }
  }

  /**
   * Pins every ACTIVE reservation for one order so it can never again be
   * picked up by the TTL expiry sweep - by setting `expiresAt` to `null`
   * ("does not expire"), not a magic far-future date. Called when an
   * order's fulfillment status moves to CONFIRMED
   * (OrdersService.updateFulfillmentStatus), inside the same transaction
   * as that status write. From this point on, only an explicit consume()
   * (payment) or release()/releaseManyInTransaction() (cancellation) can
   * resolve the reservation - never an unrelated abandoned-cart timeout.
   */
  async pinActiveForOrderInTransaction(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<void> {
    await tx.stockReservation.updateMany({
      where: { orderId, status: ReservationStatus.ACTIVE },
      data: { expiresAt: null },
    });
  }

  async findForStockItem(stockItemId: string): Promise<StockReservation[]> {
    return this.prisma.stockReservation.findMany({
      where: { stockItemId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findForOrder(orderId: string): Promise<StockReservation[]> {
    return this.prisma.stockReservation.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
