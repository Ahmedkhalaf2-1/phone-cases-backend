import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ReceiptCleanupService } from './receipt-cleanup.service';

// Runs far less often than the order-expiry sweep (60s) since receipt
// retention windows are measured in hours, not minutes - see
// RECEIPT_UNATTACHED_RETENTION_MINUTES.
const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Same bounded, reentrancy-guarded @Interval pattern as
 * OrderExpiryScheduler (see docs/DECISIONS.md for why @nestjs/schedule is
 * "the existing scheduling approach" to reuse here) - disabled under
 * NODE_ENV=test, same as OrderExpiryScheduler, so tests drive cleanup
 * explicitly via ReceiptCleanupService instead of racing a real timer.
 */
@Injectable()
export class ReceiptCleanupScheduler {
  private readonly logger = new Logger(ReceiptCleanupScheduler.name);
  private isRunning = false;

  constructor(private readonly receiptCleanupService: ReceiptCleanupService) {}

  @Interval(SWEEP_INTERVAL_MS)
  async handleInterval(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    try {
      const { deleted } = await this.receiptCleanupService.cleanupExpiredUnattached();
      if (deleted > 0) {
        this.logger.log(`Receipt cleanup: deleted ${deleted} expired unattached upload(s)`);
      }
    } catch (error) {
      this.logger.error(
        'Receipt cleanup sweep failed',
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.isRunning = false;
    }
  }
}
