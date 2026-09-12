import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { CouponType, StaffRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrderExpiryService } from '../src/modules/orders/order-expiry.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

describe('Orders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
  });

  async function seedEgyptShipping(price = 5000) {
    const zone = await prisma.shippingZone.create({
      data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
    });
    return prisma.shippingRate.create({
      data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price },
    });
  }

  // When no stockItemId is given, isUnlimitedStock: true is the explicit
  // opt-in that makes the variant purchasable at all (see
  // docs/BUSINESS_RULES.md) - these order tests are about checkout/order
  // mechanics, not the stock-tracking feature itself (which has its own
  // dedicated tests in inventory-availability.e2e-spec.ts).
  async function seedPublishedVariant(price = 10000, stockItemId?: string) {
    const product = await prisma.product.create({
      data: {
        slug: `space-${Date.now()}-${Math.random()}`,
        nameEn: 'Space',
        nameAr: 'الفضاء',
        status: 'PUBLISHED',
      },
    });
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `SPACE-${Date.now()}-${Math.random()}`,
        price,
        stockItemId,
        isUnlimitedStock: !stockItemId,
      },
    });
    return { product, variant };
  }

  async function createCartWithItem(variantId: string, quantity = 1) {
    const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
    const token = cartRes.body.token as string;
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('X-Cart-Token', token)
      .send({ variantId, quantity })
      .expect(201);
    return token;
  }

  async function quoteTotal(token: string, shippingRateId: string): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout/quote')
      .set('X-Cart-Token', token)
      .send({ country: 'EG', shippingRateId })
      .expect(201);
    return res.body.total as number;
  }

  function orderBody(overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
      customerFullName: 'Test Customer',
      customerPhone: '01012345678',
      shippingCountry: 'EG',
      shippingCity: 'Cairo',
      shippingAddressLine1: '123 Main St',
      paymentMethod: 'CASH_ON_DELIVERY',
      ...overrides,
    };
  }

  describe('payment method gate', () => {
    it('rejects public order creation with 503 when no payment method is configured', async () => {
      // AppModule's `@Module({imports:[ConfigModule.forRoot(...)]})` decorator
      // (and therefore validateEnv(process.env)) runs once, at first import of
      // app.module.ts, and every later `Test.createTestingModule` in this file
      // reuses that same cached DynamicModule/validated config - so merely
      // mutating process.env.PAYMENT_METHOD and calling createTestApp() again
      // (as the other tests' `app` already did with 'mock_dev_only') would
      // silently reuse the old value. jest.resetModules() + a fresh require
      // forces app.module.ts (and validateEnv) to re-evaluate against the
      // current process.env, giving this one gated app its own real config.
      const previous = process.env.PAYMENT_METHOD;
      process.env.PAYMENT_METHOD = 'none';
      jest.resetModules();
      let gatedApp: INestApplication;
      try {
        // The whole DI graph built from AppModule must come from the same
        // fresh module registry, or NestJS's injector fails to resolve
        // providers whose decorator metadata was captured against a
        // different copy of @nestjs/common/core - so `Test` here must be
        // re-imported fresh too, not the one statically imported above.
        const { AppModule: FreshAppModule } = (await import('../src/app.module')) as {
          AppModule: unknown;
        };
        const { Test: FreshTest } =
          (await import('@nestjs/testing')) as typeof import('@nestjs/testing');
        const moduleRef = await FreshTest.createTestingModule({
          imports: [FreshAppModule as never],
        }).compile();
        gatedApp = moduleRef.createNestApplication();
        gatedApp.setGlobalPrefix('api');
        gatedApp.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
        gatedApp.useGlobalPipes(
          new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            transformOptions: { enableImplicitConversion: true },
          }),
        );
        await gatedApp.init();

        const rate = await seedEgyptShipping();
        const { variant } = await seedPublishedVariant(10000);
        const token = await createCartWithItem(variant.id);
        const total = await quoteTotal(token, rate.id);

        await request(gatedApp.getHttpServer())
          .post('/api/v1/orders')
          .set('X-Cart-Token', token)
          .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
          .expect(503);

        await gatedApp.close();
      } finally {
        process.env.PAYMENT_METHOD = previous;
        jest.resetModules();
      }
    });
  });

  describe('order creation', () => {
    it('creates an order with a correct immutable snapshot', async () => {
      const rate = await seedEgyptShipping(5000);
      const { product, variant } = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id, 2);
      const total = await quoteTotal(token, rate.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);

      expect(res.body.orderNumber).toBe('ORD-000001');
      expect(res.body.subtotal).toBe(20000);
      expect(res.body.shippingTotal).toBe(5000);
      expect(res.body.total).toBe(25000);
      expect(res.body.fulfillmentStatus).toBe('PENDING');
      expect(res.body.paymentStatus).toBe('UNPAID');
      expect(res.body.items[0].productName).toBe('Space');
      expect(res.body.items[0].quantity).toBe(2);

      // The cart is now consumed.
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(409);

      // Product name change after the fact must not alter the snapshot.
      const owner = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${product.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ nameEn: 'Renamed Later' })
        .expect(200);

      const order = await prisma.order.findFirstOrThrow({ include: { items: true } });
      expect(order.items[0].productNameEn).toBe('Space');
    });

    it('normalizes Arabic-Indic digits in the phone number', async () => {
      const rate = await seedEgyptShipping();
      const { variant } = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            customerPhone: '٠١٠١٢٣٤٥٦٧٨',
          }),
        )
        .expect(201);

      expect(res.body.shippingAddress.phone).toBe('01012345678');
    });

    it('rejects a mismatched expectedTotal with PRICE_CHANGED and the fresh totals', async () => {
      const rate = await seedEgyptShipping(5000);
      const { variant } = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: 1 }))
        .expect(409);

      expect(res.body.code).toBe('PRICE_CHANGED');
      expect(res.body.details.total).toBe(15000);
    });

    it('rejects checkout when an item became unavailable', async () => {
      const rate = await seedEgyptShipping();
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-1', nameEn: 'Blank', onHand: 5 },
      });
      const { variant } = await seedPublishedVariant(10000, stockItem.id);
      const token = await createCartWithItem(variant.id, 1);
      const total = await quoteTotal(token, rate.id);

      await prisma.stockItem.update({ where: { id: stockItem.id }, data: { onHand: 0 } });

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(409);
      expect(res.body.code).toBe('ITEMS_UNAVAILABLE');
    });

    it('rejects checking out an empty cart', async () => {
      const rate = await seedEgyptShipping();
      const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const token = cartRes.body.token as string;

      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: 0 }))
        .expect(400);
    });
  });

  describe('idempotency', () => {
    it('returns the same order for a retried request with the same key and payload', async () => {
      const rate = await seedEgyptShipping();
      const { variant } = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);
      const body = orderBody({ shippingRateId: rate.id, expectedTotal: total });

      const first = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(body)
        .expect(201);
      const second = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(body)
        .expect(201);

      expect(second.body.orderNumber).toBe(first.body.orderNumber);
      expect(second.body.trackingToken).toBe(first.body.trackingToken);

      const orderCount = await prisma.order.count();
      expect(orderCount).toBe(1);
    });

    it('rejects reuse of the same idempotency key with a different payload', async () => {
      const rate = await seedEgyptShipping();
      const { variant } = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);
      const key = 'shared-key-123456';

      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ idempotencyKey: key, shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            idempotencyKey: key,
            shippingRateId: rate.id,
            expectedTotal: total,
            customerFullName: 'Someone Else',
          }),
        )
        .expect(409);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('prevents duplicate checkout of an already-converted cart with a new idempotency key', async () => {
      const rate = await seedEgyptShipping();
      const { variant } = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);

      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(409);
      expect(res.body.code).toBe('CART_ALREADY_ORDERED');
    });
  });

  describe('shared-stock aggregation and concurrency', () => {
    it('aggregates two cart lines sharing one StockItem into a single reservation', async () => {
      const rate = await seedEgyptShipping();
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-SHARED', nameEn: 'Blank', onHand: 10 },
      });
      const { variant: variantA } = await seedPublishedVariant(1000, stockItem.id);
      const { product: productB } = await seedPublishedVariant(1000, stockItem.id);
      const variantB = await prisma.productVariant.create({
        data: {
          productId: productB.id,
          sku: `SHARED-B-${Date.now()}`,
          price: 1000,
          stockItemId: stockItem.id,
        },
      });

      const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const token = cartRes.body.token as string;
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variantA.id, quantity: 3 })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variantB.id, quantity: 4 })
        .expect(201);
      const total = await quoteTotal(token, rate.id);

      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);

      const reservations = await prisma.stockReservation.findMany({
        where: { stockItemId: stockItem.id },
      });
      expect(reservations).toHaveLength(1);
      expect(reservations[0].quantity).toBe(7);
      const updatedStock = await prisma.stockItem.findUniqueOrThrow({
        where: { id: stockItem.id },
      });
      expect(updatedStock.reserved).toBe(7);
    });

    it('lets only one of two concurrent checkouts win the last unit of shared stock', async () => {
      const rate = await seedEgyptShipping();
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-LAST', nameEn: 'Blank', onHand: 1 },
      });
      const { variant: variantA } = await seedPublishedVariant(1000, stockItem.id);
      const { product: productB } = await seedPublishedVariant(1000, stockItem.id);
      const variantB = await prisma.productVariant.create({
        data: {
          productId: productB.id,
          sku: `LAST-B-${Date.now()}`,
          price: 1000,
          stockItemId: stockItem.id,
        },
      });

      const cartA = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const tokenA = cartA.body.token as string;
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', tokenA)
        .send({ variantId: variantA.id, quantity: 1 })
        .expect(201);
      const totalA = await quoteTotal(tokenA, rate.id);

      const cartB = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const tokenB = cartB.body.token as string;
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', tokenB)
        .send({ variantId: variantB.id, quantity: 1 })
        .expect(201);
      const totalB = await quoteTotal(tokenB, rate.id);

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/orders')
          .set('X-Cart-Token', tokenA)
          .send(orderBody({ shippingRateId: rate.id, expectedTotal: totalA })),
        request(app.getHttpServer())
          .post('/api/v1/orders')
          .set('X-Cart-Token', tokenB)
          .send(orderBody({ shippingRateId: rate.id, expectedTotal: totalB })),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const orderCount = await prisma.order.count();
      expect(orderCount).toBe(1);
      const updatedStock = await prisma.stockItem.findUniqueOrThrow({
        where: { id: stockItem.id },
      });
      expect(updatedStock.reserved).toBe(1);
    });
  });

  describe('coupon usage limits', () => {
    it('enforces the usage limit atomically under concurrent checkouts', async () => {
      const rate = await seedEgyptShipping();
      const coupon = await prisma.coupon.create({
        data: { code: 'ONEUSE', type: CouponType.FIXED, value: 100, usageLimit: 1 },
      });
      const { variant: variantA } = await seedPublishedVariant(10000);
      const { variant: variantB } = await seedPublishedVariant(10000);

      const cartA = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const tokenA = cartA.body.token as string;
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', tokenA)
        .send({ variantId: variantA.id, quantity: 1 })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/cart/coupon')
        .set('X-Cart-Token', tokenA)
        .send({ code: 'ONEUSE' })
        .expect(201);
      const totalA = await quoteTotal(tokenA, rate.id);

      const cartB = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const tokenB = cartB.body.token as string;
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', tokenB)
        .send({ variantId: variantB.id, quantity: 1 })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/cart/coupon')
        .set('X-Cart-Token', tokenB)
        .send({ code: 'ONEUSE' })
        .expect(201);
      const totalB = await quoteTotal(tokenB, rate.id);

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/orders')
          .set('X-Cart-Token', tokenA)
          .send(orderBody({ shippingRateId: rate.id, expectedTotal: totalA })),
        request(app.getHttpServer())
          .post('/api/v1/orders')
          .set('X-Cart-Token', tokenB)
          .send(orderBody({ shippingRateId: rate.id, expectedTotal: totalB })),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);

      const failed = resA.status === 409 ? resA : resB;
      expect(failed.body.code).toBe('COUPON_USAGE_LIMIT_REACHED');

      const updatedCoupon = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
      expect(updatedCoupon.usageCount).toBe(1);
    });
  });

  describe('fulfillment and payment transitions', () => {
    async function placeOrder(withStockItem?: string) {
      const rate = await seedEgyptShipping();
      const { variant } = await seedPublishedVariant(10000, withStockItem);
      const token = await createCartWithItem(variant.id, 2);
      const total = await quoteTotal(token, rate.id);
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: res.body.trackingToken },
      });
      return { order, response: res.body };
    }

    it('rejects an invalid fulfillment transition', async () => {
      const { order } = await placeOrder();
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'SHIPPED' })
        .expect(409);
    });

    it('consumes stock when payment is marked PAID', async () => {
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-PAY', nameEn: 'Blank', onHand: 10 },
      });
      const { order } = await placeOrder(stockItem.id);
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PAID' })
        .expect(200);

      const updatedStock = await prisma.stockItem.findUniqueOrThrow({
        where: { id: stockItem.id },
      });
      expect(updatedStock.onHand).toBe(8);
      expect(updatedStock.reserved).toBe(0);
    });

    it('releases the reservation and coupon usage when a PENDING order is cancelled', async () => {
      const rate = await seedEgyptShipping();
      const coupon = await prisma.coupon.create({
        data: { code: 'CANCELME', type: CouponType.FIXED, value: 100, usageLimit: 5 },
      });
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-CANCEL', nameEn: 'Blank', onHand: 10 },
      });
      const { variant } = await seedPublishedVariant(10000, stockItem.id);
      const token = await createCartWithItem(variant.id, 2);
      await request(app.getHttpServer())
        .post('/api/v1/cart/coupon')
        .set('X-Cart-Token', token)
        .send({ code: 'CANCELME' })
        .expect(201);
      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: created.body.trackingToken },
      });

      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'CANCELLED' })
        .expect(200);

      const updatedStock = await prisma.stockItem.findUniqueOrThrow({
        where: { id: stockItem.id },
      });
      expect(updatedStock.reserved).toBe(0);
      const updatedCoupon = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
      expect(updatedCoupon.usageCount).toBe(0);
    });
  });

  describe('reservation expiry protects confirmed orders', () => {
    it('cancels a PENDING/UNPAID order once its reservation expires, releasing coupon usage', async () => {
      const rate = await seedEgyptShipping();
      const coupon = await prisma.coupon.create({
        data: { code: 'EXPIREME', type: CouponType.FIXED, value: 100, usageLimit: 5 },
      });
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-EXPIRE', nameEn: 'Blank', onHand: 10 },
      });
      const { variant } = await seedPublishedVariant(10000, stockItem.id);
      const token = await createCartWithItem(variant.id, 1);
      await request(app.getHttpServer())
        .post('/api/v1/cart/coupon')
        .set('X-Cart-Token', token)
        .send({ code: 'EXPIREME' })
        .expect(201);
      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: created.body.trackingToken },
      });

      await prisma.stockReservation.updateMany({
        where: { orderId: order.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const expiryService = app.get(OrderExpiryService);
      const result = await expiryService.sweepAndCancel();
      expect(result.releasedReservations).toBe(1);
      expect(result.cancelledOrders).toBe(1);

      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.fulfillmentStatus).toBe('CANCELLED');
      const updatedStock = await prisma.stockItem.findUniqueOrThrow({
        where: { id: stockItem.id },
      });
      expect(updatedStock.reserved).toBe(0);
      const updatedCoupon = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
      expect(updatedCoupon.usageCount).toBe(0);
    });

    it('never cancels or releases stock for an order already CONFIRMED', async () => {
      const rate = await seedEgyptShipping();
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-CONFIRMED', nameEn: 'Blank', onHand: 10 },
      });
      const { variant } = await seedPublishedVariant(10000, stockItem.id);
      const token = await createCartWithItem(variant.id, 1);
      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: created.body.trackingToken },
      });

      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'CONFIRMED' })
        .expect(200);

      // Confirming must have pinned the reservation to "never expires"
      // (expiresAt: null, not a far-future date) - this is the actual
      // mechanism that protects a confirmed order's stock from an
      // unrelated checkout-abandonment timeout.
      const reservation = await prisma.stockReservation.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(reservation.expiresAt).toBeNull();
      expect(reservation.status).toBe('ACTIVE');

      const expiryService = app.get(OrderExpiryService);
      const result = await expiryService.sweepAndCancel();
      expect(result.releasedReservations).toBe(0);
      expect(result.cancelledOrders).toBe(0);

      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.fulfillmentStatus).toBe('CONFIRMED');
      const updatedStock = await prisma.stockItem.findUniqueOrThrow({
        where: { id: stockItem.id },
      });
      expect(updatedStock.reserved).toBe(1);
    });

    it('does not let a late payment confirmation silently succeed after expiry', async () => {
      const rate = await seedEgyptShipping();
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-LATE', nameEn: 'Blank', onHand: 10 },
      });
      const { variant } = await seedPublishedVariant(10000, stockItem.id);
      const token = await createCartWithItem(variant.id, 1);
      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: created.body.trackingToken },
      });

      await prisma.stockReservation.updateMany({
        where: { orderId: order.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const expiryService = app.get(OrderExpiryService);
      await expiryService.sweepAndCancel();

      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PAID' })
        .expect(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');

      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.paymentStatus).toBe('UNPAID');
    });
  });

  describe('admin authorization', () => {
    it('rejects CATALOG_MANAGER from reading admin orders', async () => {
      const { accessToken } = await createStaffAndLogin(app, StaffRole.CATALOG_MANAGER);
      await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });

    it('allows ORDER_OPERATOR to read orders and change fulfillment status but not payment status', async () => {
      const rate = await seedEgyptShipping();
      const { variant } = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: created.body.trackingToken },
      });

      const { accessToken } = await createStaffAndLogin(app, StaffRole.ORDER_OPERATOR);
      await request(app.getHttpServer())
        .get('/api/v1/admin/orders')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'CONFIRMED' })
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PAID' })
        .expect(403);
    });
  });

  describe('secure guest tracking', () => {
    it('allows tracking with the correct token', async () => {
      const rate = await seedEgyptShipping();
      const { variant } = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/track/${created.body.trackingToken}`)
        .expect(200);
      expect(res.body.orderNumber).toBe(created.body.orderNumber);
    });

    it('rejects tracking with a guessed/incorrect token', async () => {
      const rate = await seedEgyptShipping();
      const { variant } = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);
      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: total }))
        .expect(201);

      await request(app.getHttpServer()).get('/api/v1/orders/track/not-the-real-token').expect(404);
    });
  });
});
