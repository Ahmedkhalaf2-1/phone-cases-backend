import { Module } from '@nestjs/common';
import { CartModule } from '../../cart/cart.module';
import { ReceiptCleanupScheduler } from './receipt-cleanup.scheduler';
import { ReceiptCleanupService } from './receipt-cleanup.service';
import { ReceiptStorageModule } from './receipt-storage/receipt-storage.module';
import { ReceiptsAdminController } from './receipts-admin.controller';
import { ReceiptsCartController } from './receipts-cart.controller';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [CartModule, ReceiptStorageModule],
  controllers: [ReceiptsCartController, ReceiptsAdminController],
  providers: [
    ReceiptsService,
    ReceiptCleanupService,
    // Pointless (and actively unhelpful on a real clock mid-test) under
    // the e2e harness, which drives cleanup explicitly instead - same
    // reasoning as OrderExpiryScheduler in OrdersModule.
    ...(process.env.NODE_ENV === 'test' ? [] : [ReceiptCleanupScheduler]),
  ],
  exports: [ReceiptsService, ReceiptCleanupService],
})
export class PaymentReceiptsModule {}
