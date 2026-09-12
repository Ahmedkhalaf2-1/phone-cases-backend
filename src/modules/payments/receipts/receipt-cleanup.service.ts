import { Injectable } from '@nestjs/common';
import { ReceiptsService } from './receipts.service';

/**
 * Thin wrapper so the scheduler (and its admin manual-trigger twin, if one
 * is ever added) has a single, stable entry point - mirrors
 * OrderExpiryService's role relative to ReservationsService.
 */
@Injectable()
export class ReceiptCleanupService {
  constructor(private readonly receiptsService: ReceiptsService) {}

  async cleanupExpiredUnattached(limit = 200): Promise<{ deleted: number }> {
    const deleted = await this.receiptsService.deleteExpiredUnattached(limit);
    return { deleted };
  }
}
