import { Injectable } from '@nestjs/common';
import { ReservationsService } from '../inventory/reservations/reservations.service';
import { OrdersService } from './orders.service';

/**
 * Two independent sweeps, run together for convenience but no longer
 * coupled to each other:
 *
 * 1. `ReservationsService.releaseAllExpired` - stock hygiene: frees up
 *    any individual reservation whose own TTL passed, as soon as
 *    possible, regardless of the order it belongs to.
 * 2. `OrdersService.cancelExpiredOrders` - order hygiene: cancels any
 *    order whose OWN `reservationDeadline` passed while still
 *    PENDING/UNPAID, queried directly rather than derived from "which
 *    reservations did sweep #1 just release" - an order with only
 *    isUnlimitedStock items has no reservation to observe at all, and a
 *    reservation released by an unrelated lazy sweep (a different
 *    checkout touching the same stock item) must not let this order's
 *    cancellation depend on catching that exact event. See
 *    docs/DECISIONS.md for the bugs this decoupling fixes.
 *
 * An order that was confirmed or paid before its deadline passed is
 * never touched by either sweep (cancelExpiredOrders only matches
 * PENDING/UNPAID orders in the first place), so a confirmed/paid order
 * can never lose its status to an unrelated timeout.
 *
 * Recovery after downtime: both sweeps judge expiry purely from
 * timestamps already stored in the database, never an in-memory timer -
 * so if the process was down when something passed its deadline, the
 * very next sweep (scheduler tick or manual trigger) picks it up exactly
 * as if it had run on time. Nothing is lost, and nothing needs replaying.
 */
@Injectable()
export class OrderExpiryService {
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly ordersService: OrdersService,
  ) {}

  async sweepAndCancel(
    limit = 200,
  ): Promise<{ releasedReservations: number; cancelledOrders: number }> {
    const released = await this.reservationsService.releaseAllExpired(limit);
    const cancelledOrders = await this.ordersService.cancelExpiredOrders(limit);
    return { releasedReservations: released.length, cancelledOrders };
  }
}
