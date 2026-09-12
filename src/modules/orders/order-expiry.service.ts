import { Injectable, Logger } from '@nestjs/common';
import { ReservationsService } from '../inventory/reservations/reservations.service';
import { OrdersService } from './orders.service';

/**
 * Orchestrates the order-aware side of reservation expiry: sweeps every
 * expired ACTIVE reservation (ReservationsService.releaseAllExpired,
 * itself bounded and safe to call repeatedly), then cancels any order
 * whose reservation(s) just expired - but only if that order never
 * progressed past PENDING/UNPAID (OrdersService.cancelDueToExpiry is a
 * no-op otherwise), so a confirmed or paid order can never lose its
 * status to an unrelated timeout.
 *
 * Recovery after downtime: reservation expiry is judged purely from the
 * `expiresAt` timestamp already stored in the database, not an in-memory
 * timer - so if the process was down when a reservation's TTL passed,
 * the very next sweep (on the next scheduler tick, or a manual trigger)
 * picks it up exactly as if it had run on time. Nothing is lost, and
 * nothing needs replaying.
 */
@Injectable()
export class OrderExpiryService {
  private readonly logger = new Logger(OrderExpiryService.name);

  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly ordersService: OrdersService,
  ) {}

  async sweepAndCancel(
    limit = 200,
  ): Promise<{ releasedReservations: number; cancelledOrders: number }> {
    const released = await this.reservationsService.releaseAllExpired(limit);

    const orderIds = new Set(
      released.map((reservation) => reservation.orderId).filter((id): id is string => id !== null),
    );

    let cancelledOrders = 0;
    for (const orderId of orderIds) {
      try {
        const cancelled = await this.ordersService.cancelDueToExpiry(orderId);
        if (cancelled) cancelledOrders += 1;
      } catch (error) {
        // One order's cancellation failing must not stop the others from
        // being processed - log and continue; the next sweep will retry
        // this order too (cancelDueToExpiry is idempotent).
        this.logger.error(
          `Failed to cancel expired order ${orderId}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    return { releasedReservations: released.length, cancelledOrders };
  }
}
