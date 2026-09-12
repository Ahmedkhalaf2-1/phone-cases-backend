import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OrderExpiryService } from './order-expiry.service';

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Bounded, retry-safe background sweep: runs on a fixed interval within
 * this same Node process (no separate worker/queue infra - see
 * docs/DECISIONS.md for why @nestjs/schedule is "suitable for the
 * existing architecture" here). `isRunning` prevents overlapping runs if
 * one sweep somehow takes longer than the interval; `releaseAllExpired`'s
 * own `limit` bounds how much work a single tick can do. Disabled under
 * NODE_ENV=test (see OrdersModule) so test suites control sweeps
 * explicitly instead of racing a real timer.
 */
@Injectable()
export class OrderExpiryScheduler {
  private readonly logger = new Logger(OrderExpiryScheduler.name);
  private isRunning = false;

  constructor(private readonly orderExpiryService: OrderExpiryService) {}

  @Interval(SWEEP_INTERVAL_MS)
  async handleInterval(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    try {
      const result = await this.orderExpiryService.sweepAndCancel();
      if (result.releasedReservations > 0 || result.cancelledOrders > 0) {
        this.logger.log(
          `Expiry sweep: released ${result.releasedReservations} reservation(s), cancelled ${result.cancelledOrders} order(s)`,
        );
      }
    } catch (error) {
      this.logger.error('Expiry sweep failed', error instanceof Error ? error.stack : undefined);
    } finally {
      this.isRunning = false;
    }
  }
}
