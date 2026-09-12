import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

/**
 * Regression coverage for the "full stock commitment" check
 * (OrdersService.loadReservationTriage/assertStockCommitmentNotLost):
 * confirming or paying an order must verify EVERY required StockItem's
 * quantity is covered, aggregated across all of that order's
 * reservations for it - one healthy reservation must never mask another
 * lost one for a DIFFERENT required stock item, and never mask a
 * genuinely insufficient covered quantity for the SAME stock item.
 */
describe('Full stock commitment validation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
    ({ accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN));
  });

  async function seedEgyptShipping(price = 5000) {
    const zone = await prisma.shippingZone.create({
      data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
    });
    return prisma.shippingRate.create({
      data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price },
    });
  }

  async function seedVariant(price: number, stockItemId?: string) {
    const product = await prisma.product.create({
      data: {
        slug: `p-${Date.now()}-${Math.random()}`,
        nameEn: 'Case',
        nameAr: 'جراب',
        status: 'PUBLISHED',
      },
    });
    return prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `SKU-${Date.now()}-${Math.random()}`,
        price,
        stockItemId,
        isUnlimitedStock: !stockItemId,
      },
    });
  }

  async function placeOrder(lines: { variantId: string; quantity: number }[]) {
    const rate = await seedEgyptShipping();
    const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
    const token = cartRes.body.token as string;
    for (const line of lines) {
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: line.variantId, quantity: line.quantity })
        .expect(201);
    }
    const quote = await request(app.getHttpServer())
      .post('/api/v1/checkout/quote')
      .set('X-Cart-Token', token)
      .send({ country: 'EG', shippingRateId: rate.id })
      .expect(201);
    const orderRes = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('X-Cart-Token', token)
      .send({
        idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
        customerFullName: 'Test Customer',
        customerPhone: '01012345678',
        shippingCountry: 'EG',
        shippingCity: 'Cairo',
        shippingAddressLine1: '123 Main St',
        paymentMethod: 'CASH_ON_DELIVERY',
        shippingRateId: rate.id,
        expectedTotal: quote.body.total,
      })
      .expect(201);
    const order = await prisma.order.findUniqueOrThrow({
      where: { trackingToken: orderRes.body.trackingToken },
    });
    return order;
  }

  it('refuses to confirm when one required stock item is ACTIVE but another is EXPIRED', async () => {
    const stockA = await prisma.stockItem.create({
      data: { sku: `A-${Date.now()}`, nameEn: 'Blank A', onHand: 5 },
    });
    const stockB = await prisma.stockItem.create({
      data: { sku: `B-${Date.now()}`, nameEn: 'Blank B', onHand: 5 },
    });
    const variantA = await seedVariant(10000, stockA.id);
    const variantB = await seedVariant(15000, stockB.id);
    const order = await placeOrder([
      { variantId: variantA.id, quantity: 1 },
      { variantId: variantB.id, quantity: 1 },
    ]);

    const reservations = await prisma.stockReservation.findMany({ where: { orderId: order.id } });
    expect(reservations).toHaveLength(2);
    const reservationForB = reservations.find((r) => r.stockItemId === stockB.id)!;
    await prisma.stockReservation.update({
      where: { id: reservationForB.id },
      data: { status: 'EXPIRED', releasedAt: new Date() },
    });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'CONFIRMED' })
      .expect(409);
    expect(res.body.code).toBe('STOCK_RESERVATION_LOST');

    // Nothing must have been mutated - the still-ACTIVE reservation for A
    // must remain untouched (not pinned - its expiresAt is unchanged from
    // whatever it was before this failed confirm attempt), and the order
    // must remain PENDING.
    const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.fulfillmentStatus).toBe('PENDING');
    const originalReservationForA = reservations.find((r) => r.stockItemId === stockA.id)!;
    const reservationForA = await prisma.stockReservation.findUniqueOrThrow({
      where: { id: originalReservationForA.id },
    });
    expect(reservationForA.status).toBe('ACTIVE');
    expect(reservationForA.expiresAt).toEqual(originalReservationForA.expiresAt);
  });

  it('refuses to mark paid when one required stock item is CONSUMED but another is RELEASED', async () => {
    const stockA = await prisma.stockItem.create({
      data: { sku: `A-${Date.now()}`, nameEn: 'Blank A', onHand: 5 },
    });
    const stockB = await prisma.stockItem.create({
      data: { sku: `B-${Date.now()}`, nameEn: 'Blank B', onHand: 5 },
    });
    const variantA = await seedVariant(10000, stockA.id);
    const variantB = await seedVariant(15000, stockB.id);
    const order = await placeOrder([
      { variantId: variantA.id, quantity: 1 },
      { variantId: variantB.id, quantity: 1 },
    ]);
    const reservations = await prisma.stockReservation.findMany({ where: { orderId: order.id } });
    const reservationForA = reservations.find((r) => r.stockItemId === stockA.id)!;
    const reservationForB = reservations.find((r) => r.stockItemId === stockB.id)!;

    // Simulate: A was already legitimately consumed by an earlier action,
    // B was separately released (e.g. a manual admin correction) - a
    // clearly inconsistent, incomplete commitment.
    await prisma.stockReservation.update({
      where: { id: reservationForA.id },
      data: { status: 'CONSUMED', consumedAt: new Date() },
    });
    await prisma.stockReservation.update({
      where: { id: reservationForB.id },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'PAID' })
      .expect(409);
    expect(res.body.code).toBe('STOCK_RESERVATION_LOST');

    const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.paymentStatus).toBe('UNPAID');
  });

  it('refuses to confirm when the covered quantity for a stock item is insufficient, even with an ACTIVE reservation present', async () => {
    const stockItem = await prisma.stockItem.create({
      data: { sku: `INSUFFICIENT-${Date.now()}`, nameEn: 'Blank', onHand: 10 },
    });
    const variant = await seedVariant(10000, stockItem.id);
    const order = await placeOrder([{ variantId: variant.id, quantity: 2 }]);

    const reservation = await prisma.stockReservation.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(reservation.quantity).toBe(2);

    // Simulate a required quantity that is no longer fully covered: an
    // EXTRA reservation row against the same stock item for this order
    // that was never actually fulfilled - the aggregate required (2 + 1)
    // now exceeds what the remaining ACTIVE row (2) actually covers.
    await prisma.stockReservation.create({
      data: {
        stockItemId: stockItem.id,
        orderId: order.id,
        quantity: 1,
        status: 'EXPIRED',
        releasedAt: new Date(),
      },
    });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'CONFIRMED' })
      .expect(409);
    expect(res.body.code).toBe('STOCK_RESERVATION_LOST');
  });

  it('correctly aggregates multiple order lines that share the same stock item into one covered requirement', async () => {
    const stockItem = await prisma.stockItem.create({
      data: { sku: `SHARED-${Date.now()}`, nameEn: 'Shared blank', onHand: 10 },
    });
    // Two DIFFERENT variants (e.g. two print-on-demand designs) sharing
    // one physical stock item.
    const variantA = await seedVariant(10000, stockItem.id);
    const variantB = await seedVariant(12000, stockItem.id);
    const order = await placeOrder([
      { variantId: variantA.id, quantity: 2 },
      { variantId: variantB.id, quantity: 1 },
    ]);

    // Aggregated into exactly one reservation for the shared stock item.
    const reservations = await prisma.stockReservation.findMany({ where: { orderId: order.id } });
    expect(reservations).toHaveLength(1);
    expect(reservations[0].quantity).toBe(3);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'CONFIRMED' })
      .expect(200);
    expect(res.body.fulfillmentStatus).toBe('CONFIRMED');

    const pinned = await prisma.stockReservation.findUniqueOrThrow({
      where: { id: reservations[0].id },
    });
    expect(pinned.expiresAt).toBeNull();
  });

  it('confirms and pays an order mixing tracked and unlimited-stock items, using only the tracked item for its commitment check', async () => {
    const stockItem = await prisma.stockItem.create({
      data: { sku: `MIXED-${Date.now()}`, nameEn: 'Blank', onHand: 5 },
    });
    const trackedVariant = await seedVariant(10000, stockItem.id);
    const unlimitedVariant = await seedVariant(8000); // no stockItemId -> isUnlimitedStock
    const order = await placeOrder([
      { variantId: trackedVariant.id, quantity: 1 },
      { variantId: unlimitedVariant.id, quantity: 3 },
    ]);

    const reservations = await prisma.stockReservation.findMany({ where: { orderId: order.id } });
    expect(reservations).toHaveLength(1);
    expect(reservations[0].stockItemId).toBe(stockItem.id);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'CONFIRMED' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'PAID' })
      .expect(200);
    expect(res.body.paymentStatus).toBe('PAID');

    const finalStock = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
    expect(finalStock.onHand).toBe(4);
  });

  it('confirms and pays a fully-covered multi-stock-item order normally', async () => {
    const stockA = await prisma.stockItem.create({
      data: { sku: `OKA-${Date.now()}`, nameEn: 'Blank A', onHand: 5 },
    });
    const stockB = await prisma.stockItem.create({
      data: { sku: `OKB-${Date.now()}`, nameEn: 'Blank B', onHand: 5 },
    });
    const variantA = await seedVariant(10000, stockA.id);
    const variantB = await seedVariant(15000, stockB.id);
    const order = await placeOrder([
      { variantId: variantA.id, quantity: 1 },
      { variantId: variantB.id, quantity: 2 },
    ]);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${order.id}/fulfillment-status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'CONFIRMED' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'PAID' })
      .expect(200);
    expect(res.body.paymentStatus).toBe('PAID');

    const finalA = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockA.id } });
    const finalB = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockB.id } });
    expect(finalA.onHand).toBe(4);
    expect(finalB.onHand).toBe(3);
    expect(finalA.reserved).toBe(0);
    expect(finalB.reserved).toBe(0);
  });
});
