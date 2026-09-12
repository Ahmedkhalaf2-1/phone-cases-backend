import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

describe('Refunds and returns (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
    ({ accessToken: ownerToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN));
  });

  async function seedPublishedVariant(price = 10000) {
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
        isUnlimitedStock: true,
      },
    });
  }

  async function placeAndPayOrder(price = 10000, quantity = 1) {
    const zone = await prisma.shippingZone.create({
      data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
    });
    const rate = await prisma.shippingRate.create({
      data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price: 5000 },
    });
    const variant = await seedPublishedVariant(price);

    const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
    const token = cartRes.body.token as string;
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('X-Cart-Token', token)
      .send({ variantId: variant.id, quantity })
      .expect(201);

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

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'PAID' })
      .expect(200);

    const itemId = orderRes.body.items[0].id as string;
    return { orderId: order.id, itemId, total: order.total };
  }

  describe('refunds', () => {
    it('closes the generic payment-status path for refund targets', async () => {
      const { orderId } = await placeAndPayOrder();
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${orderId}/payment-status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ status: 'REFUNDED' })
        .expect(400);
    });

    it('records a partial refund and derives PARTIALLY_REFUNDED', async () => {
      const { orderId, total } = await placeAndPayOrder(10000);
      const partial = Math.floor(total / 2);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/refunds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          amount: partial,
          currency: 'EGP',
          reason: 'Goodwill partial refund',
          idempotencyKey: 'refund-key-1',
        })
        .expect(201);
      expect(res.body.amount).toBe(partial);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.paymentStatus).toBe('PARTIALLY_REFUNDED');
    });

    it('derives REFUNDED once the full amount has been refunded', async () => {
      const { orderId, total } = await placeAndPayOrder(10000);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/refunds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          amount: total,
          currency: 'EGP',
          reason: 'Full refund',
          idempotencyKey: 'refund-key-full',
        })
        .expect(201);

      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order.paymentStatus).toBe('REFUNDED');
    });

    it('refuses a refund that would exceed the amount paid', async () => {
      const { orderId, total } = await placeAndPayOrder(10000);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/refunds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          amount: total + 1,
          currency: 'EGP',
          reason: 'Too much',
          idempotencyKey: 'refund-key-2',
        })
        .expect(409);
    });

    it('refuses two partial refunds that together would exceed the amount paid', async () => {
      const { orderId, total } = await placeAndPayOrder(10000);
      const partial = Math.floor(total * 0.6);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/refunds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ amount: partial, currency: 'EGP', reason: 'First', idempotencyKey: 'refund-key-a' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/refunds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          amount: partial,
          currency: 'EGP',
          reason: 'Second',
          idempotencyKey: 'refund-key-b',
        })
        .expect(409);
    });

    it('replays an identical request with the same idempotency key as a no-op', async () => {
      const { orderId, total } = await placeAndPayOrder(10000);
      const body = {
        amount: total,
        currency: 'EGP',
        reason: 'Full refund',
        idempotencyKey: 'refund-key-idem',
      };

      const first = await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/refunds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(body)
        .expect(201);
      const second = await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/refunds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(body)
        .expect(201);

      expect(second.body.id).toBe(first.body.id);
      const refunds = await prisma.refund.findMany({ where: { orderId } });
      expect(refunds).toHaveLength(1);
    });

    it('refuses to refund an order that was never marked PAID', async () => {
      const zone = await prisma.shippingZone.create({
        data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
      });
      const rate = await prisma.shippingRate.create({
        data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price: 5000 },
      });
      const variant = await seedPublishedVariant(10000);
      const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const token = cartRes.body.token as string;
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);
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

      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${order.id}/refunds`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          amount: 1000,
          currency: 'EGP',
          reason: 'Too early',
          idempotencyKey: 'refund-key-early',
        })
        .expect(409);
    });
  });

  describe('item returns', () => {
    it('records a returned quantity for an order item', async () => {
      const { orderId, itemId } = await placeAndPayOrder(10000, 2);
      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/items/${itemId}/returns`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ quantity: 1, reason: 'Customer returned 1 unit, unopened' })
        .expect(201);
      expect(res.body.quantity).toBe(1);

      const list = await request(app.getHttpServer())
        .get(`/api/v1/admin/orders/${orderId}/items/${itemId}/returns`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(list.body).toHaveLength(1);
    });

    it('rejects returns nested under a different order than the item actually belongs to', async () => {
      const { itemId } = await placeAndPayOrder(10000, 2);
      const { orderId: unrelatedOrderId } = await placeAndPayOrder(5000, 1);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${unrelatedOrderId}/items/${itemId}/returns`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ quantity: 1, reason: 'Mismatched order' })
        .expect(404);
    });

    it('refuses a returned quantity exceeding what was purchased', async () => {
      const { orderId, itemId } = await placeAndPayOrder(10000, 2);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/items/${itemId}/returns`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ quantity: 1, reason: 'First unit' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${orderId}/items/${itemId}/returns`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ quantity: 2, reason: 'Too many' })
        .expect(409);
    });

    it('does not automatically restock - onHand is untouched by recording a return', async () => {
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-RETURN', nameEn: 'Blank', onHand: 10 },
      });
      const product = await prisma.product.create({
        data: { slug: `p-${Date.now()}`, nameEn: 'Case', nameAr: 'جراب', status: 'PUBLISHED' },
      });
      const variant = await prisma.productVariant.create({
        data: {
          productId: product.id,
          sku: `SKU-${Date.now()}`,
          price: 10000,
          stockItemId: stockItem.id,
        },
      });
      const zone = await prisma.shippingZone.create({
        data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
      });
      const rate = await prisma.shippingRate.create({
        data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price: 5000 },
      });
      const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const token = cartRes.body.token as string;
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);
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
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/orders/${order.id}/payment-status`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ status: 'PAID' })
        .expect(200);

      const itemId = orderRes.body.items[0].id as string;
      await request(app.getHttpServer())
        .post(`/api/v1/admin/orders/${order.id}/items/${itemId}/returns`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ quantity: 1, reason: 'Returned, will inspect before restocking' })
        .expect(201);

      const afterReturn = await prisma.stockItem.findUniqueOrThrow({ where: { id: stockItem.id } });
      expect(afterReturn.onHand).toBe(9); // unchanged by the return itself (consumed at PAID time)

      // Restocking requires the SEPARATE, explicit stock-adjustment action:
      const restock = await request(app.getHttpServer())
        .patch(`/api/v1/admin/stock-items/${stockItem.id}/adjust`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ delta: 1, reason: 'Restocked after inspection - unopened return' })
        .expect(200);
      expect(restock.body.onHand).toBe(10);

      const movements = await prisma.stockMovement.findMany({
        where: { stockItemId: stockItem.id },
      });
      const restockMovement = movements.find((m) => m.delta === 1);
      expect(restockMovement?.reason).toBe('Restocked after inspection - unopened return');
    });
  });
});
