import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

// The driver adapter needs an already-resolved DATABASE_URL, so it cannot
// be built at module-evaluation time (import side effects run before
// Nest's ConfigModule has loaded .env into process.env). Building it here,
// from an injected ConfigService, defers construction until Nest actually
// instantiates this provider - by which point ConfigModule has already run.
function createAdapter(configService: ConfigService): PrismaPg {
  return new PrismaPg({ connectionString: configService.getOrThrow<string>('DATABASE_URL') });
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(configService: ConfigService) {
    super({ adapter: createAdapter(configService) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Removes fields that must never leave the process (password hashes,
   * internal notes, etc) is handled by DTO mappers, not here. This helper
   * only centralizes cleanup for tests that truncate between runs.
   */
  async cleanDatabaseForTests(): Promise<void> {
    if (process.env.NODE_ENV !== 'test') {
      this.logger.warn('cleanDatabaseForTests called outside of NODE_ENV=test, refusing.');
      return;
    }

    const tableNames = [
      'audit_logs',
      'homepage_sections',
      'pages',
      'payment_receipts',
      'refunds',
      'order_item_returns',
      'order_item_custom_designs',
      'bundle_instances',
      'order_items',
      'orders',
      'bundle_eligible_variants',
      'bundle_promotions',
      'cart_items',
      'custom_designs',
      'carts',
      'coupons',
      'shipping_rates',
      'shipping_zones',
      'stock_reservations',
      'stock_movements',
      'variant_media',
      'product_media',
      'media_assets',
      'print_specifications',
      'product_variants',
      'stock_items',
      'product_collections',
      'products',
      'collections',
      'case_types',
      'phone_models',
      'phone_brands',
      'staff_refresh_tokens',
      'staff_users',
    ];

    // A single TRUNCATE listing every table is one round trip instead of
    // fourteen, and the explicit timeout gives headroom under the kind of
    // resource contention a shared CI/sandbox machine can have - Prisma's
    // default interactive-transaction timeout (5s) was occasionally too
    // tight for this single statement alone under load.
    const quotedNames = tableNames.map((name) => `"${name}"`).join(', ');
    await this.$transaction(
      [this.$executeRawUnsafe(`TRUNCATE TABLE ${quotedNames} RESTART IDENTITY CASCADE;`)],
      { timeout: 20_000 },
    );
  }
}
