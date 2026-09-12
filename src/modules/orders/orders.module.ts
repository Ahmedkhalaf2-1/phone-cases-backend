import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { ReservationsModule } from '../inventory/reservations/reservations.module';
import { PaymentReceiptsModule } from '../payments/receipts/payment-receipts.module';
import { ShippingModule } from '../shipping/shipping.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { OrderExpiryAdminController } from './order-expiry-admin.controller';
import { OrderExpiryScheduler } from './order-expiry.scheduler';
import { OrderExpiryService } from './order-expiry.service';
import { OrdersAdminController } from './orders-admin.controller';
import { OrdersPublicController } from './orders-public.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [CartModule, ReservationsModule, ShippingModule, PaymentReceiptsModule],
  controllers: [
    CheckoutController,
    OrdersPublicController,
    OrdersAdminController,
    OrderExpiryAdminController,
  ],
  providers: [
    CheckoutService,
    OrdersService,
    OrderExpiryService,
    // The real timer is pointless (and actively unhelpful - it would fire
    // mid-test on a real clock) under the e2e test harness, which drives
    // expiry explicitly via OrderExpiryService instead. Same pattern as
    // ThrottlerGuard in AppModule.
    ...(process.env.NODE_ENV === 'test' ? [] : [OrderExpiryScheduler]),
  ],
  exports: [OrdersService, OrderExpiryService],
})
export class OrdersModule {}
