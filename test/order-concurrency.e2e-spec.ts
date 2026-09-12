import { INestApplication } from '@nestjs/common';
import { CouponType, StaffRole } from '@prisma/client';
import request from 'supertest';
import sharp from 'sharp';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersService } from '../src/modules/orders/orders.service';
import { OrderExpiryService } from '../src/modules/orders/order-expiry.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

/**
 * Deterministically forces `firstOp` to acquire OrdersService's internal
 * order-row lock (`lockOrderForUpdate`) before `secondOp` even starts, and
 * PROVES `secondOp` genuinely blocks on Postgres's real row lock until
 * `firstOp` commits or rolls back - not just favorable `Promise.all`
 * timing (which cannot reliably reproduce a specific interleaving). Only
 * the FIRST call to `lockOrderForUpdate` is intercepted and paused; every
 * other call (including `secondOp`'s own) falls through to the real
 * implementation, so the actual blocking is enforced by Postgres itself,
 * not by test-side mocking.
 */
async function raceOrderLockedOperations<A, B>(
  ordersService: OrdersService,
  firstOp: () => Promise<A>,
  secondOp: () => Promise<B>,
): Promise<{ first: A; second: B }> {
  const target = ordersService as unknown as {
    lockOrderForUpdate: (...args: unknown[]) => Promise<unknown>;
  };
  const originalLock = target.lockOrderForUpdate.bind(ordersService);

  let releaseFirst!: () => void;
  const releaseGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstLockAcquired!: () => void;
  const lockAcquiredSignal = new Promise<void>((resolve) => {
    firstLockAcquired = resolve;
  });

  const lockSpy = jest.spyOn(target, 'lockOrderForUpdate');
  lockSpy.mockImplementationOnce(async (...args: unknown[]) => {
    const result = await originalLock(...args);
    firstLockAcquired();
    await releaseGate;
    return result;
  });

  try {
    const firstPromise = firstOp();
    // supertest's Test object only actually dispatches the HTTP request
    // once something drives it (an explicit `.then`/`.catch`/`await`) -
    // attaching a harmless no-op handler HERE, synchronously, forces that
    // dispatch to happen immediately rather than lazily whenever
    // `firstPromise` is finally awaited later in this function (which
    // would otherwise deadlock: nothing drives the request, so the lock
    // is never acquired, so `lockAcquiredSignal` never resolves).
    firstPromise.catch(() => undefined);

    // If firstOp settles (resolves OR throws) WITHOUT ever acquiring the
    // lock, surface that immediately as a clear test failure instead of
    // hanging until Jest's own test timeout with no diagnostic.
    const lockOrFirstSettled = await Promise.race([
      lockAcquiredSignal.then(() => 'lock-acquired' as const),
      firstPromise.then(
        () => 'first-settled' as const,
        () => 'first-settled' as const,
      ),
    ]);
    if (lockOrFirstSettled === 'first-settled') {
      throw new Error(
        'raceOrderLockedOperations: firstOp settled without ever acquiring the order lock - ' +
          'it must call OrdersService.lockOrderForUpdate for this helper to control the race',
      );
    }

    const secondPromise = secondOp();
    secondPromise.catch(() => undefined);

    const PENDING = 'still-pending';
    const raceOutcome = await Promise.race([
      secondPromise.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve(PENDING), 250)),
    ]);
    expect(raceOutcome).toBe(PENDING);

    releaseFirst();
    const first = await firstPromise;
    const second = await secondPromise;
    return { first, second };
  } finally {
    lockSpy.mockRestore();
  }
}

describe('Order/checkout concurrency and lifecycle correctness (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ordersService: OrdersService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ordersService = app.get(OrdersService);
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

  describe('simultaneous identical checkout retries return the same order', () => {
    it('returns the same order to both of two simultaneous, byte-for-byte identical CASH_ON_DELIVERY retries', async () => {
      const rate = await seedEgyptShipping();
      const variant = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);
      const body = orderBody({ shippingRateId: rate.id, expectedTotal: total });

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer()).post('/api/v1/orders').set('X-Cart-Token', token).send(body),
        request(app.getHttpServer()).post('/api/v1/orders').set('X-Cart-Token', token).send(body),
      ]);

      // Same cart, same key, same payload, genuinely concurrent - BOTH
      // must succeed and return the exact same committed order, never
      // CART_ALREADY_ORDERED for the request that lost the cart-claim
      // race but was actually just a retry of the winner's own request.
      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);
      expect(resA.body.trackingToken).toBe(resB.body.trackingToken);
      expect(await prisma.order.count()).toBe(1);
    });

    it('returns the same order to both of two simultaneous, identical INSTAPAY_MANUAL retries referencing the same receipt', async () => {
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
      const body = orderBody({
        shippingRateId: rate.id,
        expectedTotal: total,
        paymentMethod: 'INSTAPAY_MANUAL',
        receiptId: upload.body.receiptId,
      });

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer()).post('/api/v1/orders').set('X-Cart-Token', token).send(body),
        request(app.getHttpServer()).post('/api/v1/orders').set('X-Cart-Token', token).send(body),
      ]);

      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);
      expect(resA.body.trackingToken).toBe(resB.body.trackingToken);
      expect(await prisma.order.count()).toBe(1);

      // The receipt was attached exactly once, by whichever request
      // actually won the cart claim - never left unattached, never
      // double-attached, never rejected as RECEIPT_ALREADY_ATTACHED for
      // the request that was really just this same retry.
      const receipt = await prisma.paymentReceipt.findUniqueOrThrow({
        where: { id: upload.body.receiptId as string },
      });
      expect(receipt.orderId).not.toBeNull();
    });

    it('still returns the documented conflict when the same key is concurrently reused with a genuinely different payload on the same cart', async () => {
      const rate = await seedEgyptShipping();
      const variant = await seedPublishedVariant(10000);
      const token = await createCartWithItem(variant.id);
      const total = await quoteTotal(token, rate.id);
      const sharedKey = `shared-key-${Math.random().toString(36).slice(2)}`;

      const [resA, resB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/orders')
          .set('X-Cart-Token', token)
          .send(
            orderBody({
              idempotencyKey: sharedKey,
              shippingRateId: rate.id,
              expectedTotal: total,
              customerFullName: 'Customer A',
            }),
          ),
        request(app.getHttpServer())
          .post('/api/v1/orders')
          .set('X-Cart-Token', token)
          .send(
            orderBody({
              idempotencyKey: sharedKey,
              shippingRateId: rate.id,
              expectedTotal: total,
              customerFullName: 'Customer B - different payload, same key',
            }),
          ),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);
      const failed = resA.status === 409 ? resA : resB;
      expect(failed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await prisma.order.count()).toBe(1);
    });
  });

  describe('confirmation vs cancellation cannot contradict each other', () => {
    // CONFIRMED -> CANCELLED is a legitimate, independently valid
    // transition (see FULFILLMENT_TRANSITIONS) - so which of these two
    // concurrent requests "wins" genuinely depends on which acquires the
    // order lock first, and the OTHER one's correct outcome depends on
    // that too (CANCELLED is still valid from a just-CONFIRMED order;
    // CONFIRMED is never valid from an already-CANCELLED order). A bare
    // `Promise.all` cannot pin down which ordering actually happened, so
    // both orderings are tested deterministically here instead.
    async function placeTrackedStockOrder() {
      const rate = await seedEgyptShipping();
      const stockItem = await prisma.stockItem.create({
        data: { sku: `BLANK-RACE-${Date.now()}-${Math.random()}`, nameEn: 'Blank', onHand: 5 },
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
      return { order, stockItem };
    }

    it('lets a cancellation that arrives after confirmation already committed still succeed, releasing the just-pinned reservation', async () => {
      const { order, stockItem } = await placeTrackedStockOrder();
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

      const { first: confirmRes, second: cancelRes } = await raceOrderLockedOperations(
        ordersService,
        () =>
          request(app.getHttpServer())
            .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ status: 'CONFIRMED' }),
        () =>
          request(app.getHttpServer())
            .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ status: 'CANCELLED' }),
      );

      expect(confirmRes.status).toBe(200);
      expect(cancelRes.status).toBe(200);

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const finalStock = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
      const reservation = await prisma.stockReservation.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(finalOrder.fulfillmentStatus).toBe('CANCELLED');
      // Pinned by CONFIRMED (expiresAt: null), then correctly released by
      // the CANCELLED that followed - never left ACTIVE, never left both
      // pinned AND reserved with no cancellation reflected.
      expect(reservation.status).not.toBe('ACTIVE');
      expect(finalStock.reserved).toBe(0);
    });

    it('rejects a confirmation that arrives after cancellation already committed', async () => {
      const { order, stockItem } = await placeTrackedStockOrder();
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

      const { first: cancelRes, second: confirmRes } = await raceOrderLockedOperations(
        ordersService,
        () =>
          request(app.getHttpServer())
            .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ status: 'CANCELLED' }),
        () =>
          request(app.getHttpServer())
            .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ status: 'CONFIRMED' }),
      );

      expect(cancelRes.status).toBe(200);
      expect(confirmRes.status).toBe(409);
      expect(confirmRes.body.code).toBe('INVALID_STATE_TRANSITION');

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      const finalStock = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
      const reservation = await prisma.stockReservation.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(finalOrder.fulfillmentStatus).toBe('CANCELLED');
      expect(reservation.status).not.toBe('ACTIVE');
      expect(finalStock.reserved).toBe(0);
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

  describe('deterministic order-row locking (controlled interleaving, not Promise.all luck)', () => {
    it('rejects payment confirmation that arrives after expiry-cancellation already committed, for an unlimited-stock InstaPay order', async () => {
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
      expect(await prisma.stockReservation.count({ where: { orderId: order.id } })).toBe(0);
      await prisma.order.update({
        where: { id: order.id },
        data: { reservationDeadline: new Date(Date.now() - 60_000) },
      });
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      const expiryService = app.get(OrderExpiryService);

      // The expiry sweep acquires the order lock FIRST (and is held open
      // deterministically) - a payment confirmation started only after
      // that must block on Postgres's real row lock, then see the
      // already-CANCELLED order once unblocked.
      const { first: sweepResult, second: paymentRes } = await raceOrderLockedOperations(
        ordersService,
        () => expiryService.sweepAndCancel(),
        () =>
          request(app.getHttpServer())
            .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ status: 'PAID' }),
      );

      expect(sweepResult.cancelledOrders).toBe(1);
      expect(paymentRes.status).toBe(409);
      expect(paymentRes.body.code).toBe('INVALID_STATE_TRANSITION');

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.fulfillmentStatus).toBe('CANCELLED');
      expect(finalOrder.paymentStatus).toBe('UNPAID');

      // The receipt must never have been silently accepted for an order
      // that ended up cancelled, not paid.
      const receipt = await prisma.paymentReceipt.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(receipt.status).toBe('PENDING_REVIEW');
    });

    it('rejects a manual cancellation that arrives after payment already committed, and never releases coupon usage using stale unpaid state', async () => {
      const rate = await seedEgyptShipping();
      const variant = await seedPublishedVariant(20000); // isUnlimitedStock
      const coupon = await prisma.coupon.create({
        data: { code: 'RACEFIX', type: CouponType.FIXED, value: 1000, usageLimit: 5 },
      });
      const token = await createCartWithItem(variant.id);
      await request(app.getHttpServer())
        .post('/api/v1/cart/coupon')
        .set('X-Cart-Token', token)
        .send({ code: 'RACEFIX' })
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
      expect(order.couponId).toBe(coupon.id);
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

      // Payment confirmation acquires the lock first and is held open;
      // a manual cancellation started only afterward must block, then
      // see the order as already PAID once unblocked - fulfillment
      // cancellation of a paid order is still a legitimate, ALLOWED
      // action (see docs/BUSINESS_RULES.md), but it must never release
      // coupon usage for an order that is, in fact, paid.
      const { first: paymentRes, second: cancelRes } = await raceOrderLockedOperations(
        ordersService,
        () =>
          request(app.getHttpServer())
            .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ status: 'PAID' }),
        () =>
          request(app.getHttpServer())
            .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ status: 'CANCELLED' }),
      );

      expect(paymentRes.status).toBe(200);
      // Cancelling a PAID order's fulfillment is legitimate and allowed.
      expect(cancelRes.status).toBe(200);

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.paymentStatus).toBe('PAID');
      expect(finalOrder.fulfillmentStatus).toBe('CANCELLED');
      // Coupon usage must NOT have been released - the order is paid.
      expect(finalOrder.couponUsageReleased).toBe(false);

      const finalCoupon = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
      expect(finalCoupon.usageCount).toBe(1);
    });

    it('rejects a confirmation that arrives after expiry-cancellation already committed, for a TRACKED-stock order', async () => {
      const rate = await seedEgyptShipping();
      const stockItem = await prisma.stockItem.create({
        data: { sku: `BLANK-LOCKRACE-${Date.now()}`, nameEn: 'Blank', onHand: 5 },
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
      await prisma.order.update({
        where: { id: order.id },
        data: { reservationDeadline: new Date(Date.now() - 60_000) },
      });
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      const expiryService = app.get(OrderExpiryService);

      const { first: sweepResult, second: confirmRes } = await raceOrderLockedOperations(
        ordersService,
        () => expiryService.sweepAndCancel(),
        () =>
          request(app.getHttpServer())
            .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ status: 'CONFIRMED' }),
      );

      expect(sweepResult.cancelledOrders).toBe(1);
      expect(confirmRes.status).toBe(409);
      expect(confirmRes.body.code).toBe('INVALID_STATE_TRANSITION');

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.fulfillmentStatus).toBe('CANCELLED');
      const finalStock = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
      expect(finalStock.reserved).toBe(0);
      const reservation = await prisma.stockReservation.findFirstOrThrow({
        where: { orderId: order.id },
      });
      expect(reservation.status).toBe('EXPIRED');
    });
  });
});
