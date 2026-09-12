import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import sharp from 'sharp';
import { PrismaService } from '../src/prisma/prisma.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

describe('Order/checkout concurrency and lifecycle correctness (e2e)', () => {
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

  async function seedPublishedVariant(price = 10000, stockItemId?: string) {
    const product = await prisma.product.create({
      data: {
        slug: `space-${Date.now()}-${Math.random()}`,
        nameEn: 'Space',
        nameAr: 'الفضاء',
        status: 'PUBLISHED',
      },
    });
    return prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `SPACE-${Date.now()}-${Math.random()}`,
        price,
        stockItemId,
        isUnlimitedStock: !stockItemId,
      },
    });
  }

  async function createCartWithItem(variantId: string, quantity = 1): Promise<string> {
    const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
    const token = cartRes.body.token as string;
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('X-Cart-Token', token)
      .send({ variantId, quantity })
      .expect(201);
    return token;
  }

  async function quoteTotal(token: string, rateId: string): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout/quote')
      .set('X-Cart-Token', token)
      .send({ country: 'EG', shippingRateId: rateId })
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

  describe('idempotency is scoped to the owning cart', () => {
    it('rejects a key already used by a different cart, even with an identical payload', async () => {
      const rate = await seedEgyptShipping();
      const variant = await seedPublishedVariant(10000);

      const tokenA = await createCartWithItem(variant.id);
      const totalA = await quoteTotal(tokenA, rate.id);
      const sharedKey = 'shared-idempotency-key-123';
      const body = orderBody({
        idempotencyKey: sharedKey,
        shippingRateId: rate.id,
        expectedTotal: totalA,
      });

      const first = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', tokenA)
        .send(body)
        .expect(201);

      // A different cart, coincidentally sending the exact same body
      // (same key, same everything) - must never receive cart A's order.
      const tokenB = await createCartWithItem(variant.id);
      const res = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', tokenB)
        .send(body)
        .expect(409);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(res.body.trackingToken).not.toBe(first.body.trackingToken);

      const orderCount = await prisma.order.count();
      expect(orderCount).toBe(1);
    });
  });

  describe('one cart can never produce two orders', () => {
    it('lets only one of two concurrent checkout attempts (different idempotency keys) on the same cart succeed', async () => {
      const rate = await seedEgyptShipping();
      const variant = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/orders')
          .set('X-Cart-Token', token)
          .send(orderBody({ shippingRateId: rate.id, expectedTotal: total })),
        request(app.getHttpServer())
          .post('/api/v1/orders')
          .set('X-Cart-Token', token)
          .send(orderBody({ shippingRateId: rate.id, expectedTotal: total })),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);
      const failed = resA.status === 409 ? resA : resB;
      expect(failed.body.code).toBe('CART_ALREADY_ORDERED');

      expect(await prisma.order.count()).toBe(1);
    });
  });

  describe('confirmation vs cancellation cannot contradict each other', () => {
    it('lets only one of two concurrent fulfillment-status changes win, without applying both side effects', async () => {
      const rate = await seedEgyptShipping();
      const stockItem = await prisma.stockItem.create({
        data: { sku: `BLANK-RACE-${Date.now()}`, nameEn: 'Blank', onHand: 5 },
      });
      const variant = await seedPublishedVariant(10000, stockItem.id);
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
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

      const [resConfirm, resCancel] = await Promise.all([
        request(app.getHttpServer())
          .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ status: 'CONFIRMED' }),
        request(app.getHttpServer())
          .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ status: 'CANCELLED' }),
      ]);

      const statuses = [resConfirm.status, resCancel.status].sort();
      // Exactly one must win (200); the other must be rejected as a
      // conflicting concurrent change, never both silently "succeeding".
      expect(statuses).toEqual([200, 409]);

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const finalStock = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
      const reservation = await prisma.stockReservation.findFirstOrThrow({
        where: { orderId: order.id },
      });

      if (finalOrder.fulfillmentStatus === 'CONFIRMED') {
        // CONFIRMED won: the reservation must be pinned (never expires),
        // and stock is still held (reserved), not released.
        expect(reservation.expiresAt).toBeNull();
        expect(reservation.status).toBe('ACTIVE');
        expect(finalStock.reserved).toBe(1);
      } else {
        // CANCELLED won: the reservation must actually be released.
        expect(finalOrder.fulfillmentStatus).toBe('CANCELLED');
        expect(reservation.status).not.toBe('ACTIVE');
        expect(finalStock.reserved).toBe(0);
      }
    });
  });

  describe('COD deadline behavior', () => {
    it('gives a CASH_ON_DELIVERY order no reservationDeadline by default, even with tracked stock', async () => {
      const rate = await seedEgyptShipping();
      const stockItem = await prisma.stockItem.create({
        data: { sku: `BLANK-COD-${Date.now()}`, nameEn: 'Blank', onHand: 5 },
      });
      const variant = await seedPublishedVariant(10000, stockItem.id);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'CASH_ON_DELIVERY',
          }),
        )
        .expect(201);

      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: created.body.trackingToken },
      });
      expect(order.reservationDeadline).toBeNull();

      // The sweep must never touch this order, no matter how much time
      // has "passed" - there is nothing to compare against.
      const { OrderExpiryService } = await import('../src/modules/orders/order-expiry.service');
      const expiryService = app.get(OrderExpiryService);
      const result = await expiryService.sweepAndCancel();
      expect(result.cancelledOrders).toBe(0);
      const stillPending = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(stillPending.fulfillmentStatus).toBe('PENDING');
    });
  });

  describe('InstaPay expiry without tracked stock', () => {
    it('still auto-cancels an InstaPay order made entirely of isUnlimitedStock items once its review deadline passes', async () => {
      const rate = await seedEgyptShipping();
      const variant = await seedPublishedVariant(10000); // no stockItemId -> isUnlimitedStock
      const token = await createCartWithItem(variant.id);

      const upload = await request(app.getHttpServer())
        .post('/api/v1/cart/receipts')
        .set('X-Cart-Token', token)
        .attach(
          'file',
          await sharp({
            create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } },
          })
            .png()
            .toBuffer(),
          { filename: 'r.png', contentType: 'image/png' },
        )
        .expect(201);

      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'INSTAPAY_MANUAL',
            receiptId: upload.body.receiptId,
          }),
        )
        .expect(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: created.body.trackingToken },
      });
      expect(order.reservationDeadline).not.toBeNull();
      expect(await prisma.stockReservation.count({ where: { orderId: order.id } })).toBe(0);

      await prisma.order.update({
        where: { id: order.id },
        data: { reservationDeadline: new Date(Date.now() - 60_000) },
      });

      const { OrderExpiryService } = await import('../src/modules/orders/order-expiry.service');
      const expiryService = app.get(OrderExpiryService);
      const result = await expiryService.sweepAndCancel();
      expect(result.cancelledOrders).toBe(1);

      const cancelled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(cancelled.fulfillmentStatus).toBe('CANCELLED');
    });
  });

  describe('receipt acceptance is atomic with payment confirmation', () => {
    it('accepting payment for an InstaPay order accepts its pending receipt in the same action', async () => {
      const rate = await seedEgyptShipping();
      const variant = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const upload = await request(app.getHttpServer())
        .post('/api/v1/cart/receipts')
        .set('X-Cart-Token', token)
        .attach(
          'file',
          await sharp({
            create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } },
          })
            .png()
            .toBuffer(),
          { filename: 'r.png', contentType: 'image/png' },
        )
        .expect(201);
      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'INSTAPAY_MANUAL',
            receiptId: upload.body.receiptId,
          }),
        )
        .expect(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: created.body.trackingToken },
      });
      const { accessToken, staffId } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PAID' })
        .expect(200);

      const receipt = await prisma.paymentReceipt.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(receipt.status).toBe('ACCEPTED');
      expect(receipt.reviewedByStaffId).toBe(staffId);
      expect(receipt.reviewedAt).not.toBeNull();

      // An accepted receipt can no longer be rejected.
      const rejectRes = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/receipts/${receipt.id}/reject`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ reason: 'too late' })
        .expect(409);
      expect(rejectRes.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('refuses to mark an InstaPay order paid when there is no receipt pending review', async () => {
      const rate = await seedEgyptShipping();
      const variant = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const upload = await request(app.getHttpServer())
        .post('/api/v1/cart/receipts')
        .set('X-Cart-Token', token)
        .attach(
          'file',
          await sharp({
            create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } },
          })
            .png()
            .toBuffer(),
          { filename: 'r.png', contentType: 'image/png' },
        )
        .expect(201);
      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'INSTAPAY_MANUAL',
            receiptId: upload.body.receiptId,
          }),
        )
        .expect(201);
      const order = await prisma.order.findUniqueOrThrow({
        where: { trackingToken: created.body.trackingToken },
      });
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      const receipt = await prisma.paymentReceipt.findFirstOrThrow({
        where: { orderId: order.id },
      });

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/receipts/${receipt.id}/reject`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ reason: 'blurry' })
        .expect(200);

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PAID' })
        .expect(409);
      expect(res.body.code).toBe('NO_PENDING_RECEIPT');
    });
  });

  describe('InstaPay cannot reach preparation before payment', () => {
    it('rejects moving an unpaid InstaPay order to PREPARING', async () => {
      const rate = await seedEgyptShipping();
      const variant = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const upload = await request(app.getHttpServer())
        .post('/api/v1/cart/receipts')
        .set('X-Cart-Token', token)
        .attach(
          'file',
          await sharp({
            create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 1, b: 1 } },
          })
            .png()
            .toBuffer(),
          { filename: 'r.png', contentType: 'image/png' },
        )
        .expect(201);
      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'INSTAPAY_MANUAL',
            receiptId: upload.body.receiptId,
          }),
        )
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

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PREPARING' })
        .expect(409);
      expect(res.body.code).toBe('PAYMENT_NOT_CONFIRMED');
    });

    it('allows a COD order to reach PREPARING while still unpaid', async () => {
      const rate = await seedEgyptShipping();
      const variant = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(
          orderBody({
            shippingRateId: rate.id,
            expectedTotal: total,
            paymentMethod: 'CASH_ON_DELIVERY',
          }),
        )
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
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PREPARING' })
        .expect(200);
      expect(res.body.paymentStatus).toBe('UNPAID');
      expect(res.body.fulfillmentStatus).toBe('PREPARING');
    });
  });

  describe('confirming a tracked-stock order whose reservation is already lost', () => {
    it('refuses to confirm and requires manual review', async () => {
      const rate = await seedEgyptShipping();
      const stockItem = await prisma.stockItem.create({
        data: { sku: `BLANK-LOST-${Date.now()}`, nameEn: 'Blank', onHand: 5 },
      });
      const variant = await seedPublishedVariant(10000, stockItem.id);
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

      await prisma.stockReservation.updateMany({
        where: { orderId: order.id },
        data: { status: 'EXPIRED', releasedAt: new Date() },
      });

      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'CONFIRMED' })
        .expect(409);
      expect(res.body.code).toBe('STOCK_RESERVATION_LOST');
    });
  });
});
