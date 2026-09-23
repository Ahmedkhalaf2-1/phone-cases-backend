import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { MediaUrlRewriteInterceptor } from './common/interceptors/media-url-rewrite.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { validateEnv } from './config/env.validation';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { AuthModule } from './modules/auth/auth.module';
import { CartModule } from './modules/cart/cart.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { ContentModule } from './modules/content/content.module';
import { CustomDesignsModule } from './modules/custom-designs/custom-designs.module';
import { HealthModule } from './modules/health/health.module';
import { StockItemsModule } from './modules/inventory/stock-items/stock-items.module';
import { OrdersModule } from './modules/orders/orders.module';
import { BundlesModule } from './modules/promotions/bundles/bundles.module';
import { CouponsModule } from './modules/promotions/coupons/coupons.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { StaffModule } from './modules/staff/staff.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['.env'],
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 120 }],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuditLogModule,
    AuthModule,
    StaffModule,
    CatalogModule,
    StockItemsModule,
    CouponsModule,
    BundlesModule,
    CustomDesignsModule,
    CartModule,
    ShippingModule,
    OrdersModule,
    ContentModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MediaUrlRewriteInterceptor },
    // Skipped under the e2e test harness: tests legitimately log in far
    // more often per minute than any real client would, and asserting
    // functional behavior shouldn't be coupled to rate-limit counters.
    // Rate limiting itself is still exercised in real dev/prod runs.
    ...(process.env.NODE_ENV === 'test' ? [] : [{ provide: APP_GUARD, useClass: ThrottlerGuard }]),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
