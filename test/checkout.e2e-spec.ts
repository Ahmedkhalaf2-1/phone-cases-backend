import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, resetDatabase } from './utils/test-app';

describe('Checkout quote (e2e)', () => {
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

  async function seedEgyptShipping(price = 5000, freeShippingThreshold: number | null = null) {
    const zone = await prisma.shippingZone.create({
      data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
    });
    return prisma.shippingRate.create({
      data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price, freeShippingThreshold },
    });
  }

  async function seedPublishedVariant(price = 10000) {
    const product = await prisma.product.create({
      data: { slug: 'space', nameEn: 'Space', nameAr: 'الفضاء', status: 'PUBLISHED' },
    });
    return prisma.productVariant.create({ data: { productId: product.id, sku: 'SPACE-1', price } });
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

  it('computes subtotal, shipping and total for a valid destination', async () => {
    const rate = await seedEgyptShipping(5000);
    const variant = await seedPublishedVariant(10000);
    const token = await createCartWithItem(variant.id, 2);

    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout/quote')
      .set('X-Cart-Token', token)
      .send({ country: 'EG', shippingRateId: rate.id })
      .expect(201);

    expect(res.body.subtotal).toBe(20000);
    expect(res.body.shippingTotal).toBe(5000);
    expect(res.body.total).toBe(25000);
    expect(res.body.issues).toEqual([]);
  });

  it('applies a free-shipping threshold based on the post-discount total', async () => {
    const rate = await seedEgyptShipping(5000, 15000);
    const variant = await seedPublishedVariant(20000);
    const token = await createCartWithItem(variant.id, 1);

    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout/quote')
      .set('X-Cart-Token', token)
      .send({ country: 'EG', shippingRateId: rate.id })
      .expect(201);

    expect(res.body.subtotal).toBe(20000);
    expect(res.body.shippingTotal).toBe(0);
    expect(res.body.total).toBe(20000);
  });

  it('rejects an unsupported destination', async () => {
    const rate = await seedEgyptShipping(5000);
    const variant = await seedPublishedVariant(10000);
    const token = await createCartWithItem(variant.id, 1);

    await request(app.getHttpServer())
      .post('/api/v1/checkout/quote')
      .set('X-Cart-Token', token)
      .send({ country: 'US', shippingRateId: rate.id })
      .expect(409);
  });

  it('flags unavailable items as issues without failing the whole quote', async () => {
    const rate = await seedEgyptShipping(5000);
    const stockItem = await prisma.stockItem.create({
      data: { sku: 'BLANK-1', nameEn: 'Blank', onHand: 0 },
    });
    const product = await prisma.product.create({
      data: { slug: 'space', nameEn: 'Space', nameAr: 'الفضاء', status: 'PUBLISHED' },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, sku: 'SPACE-1', price: 10000, stockItemId: stockItem.id },
    });
    // Add while stock still available, then deplete it before quoting -
    // the cart itself never re-checks; the quote must.
    const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
    const token = cartRes.body.token as string;
    await prisma.stockItem.update({ where: { id: stockItem.id }, data: { onHand: 5 } });
    await request(app.getHttpServer())
      .post('/api/v1/cart/items')
      .set('X-Cart-Token', token)
      .send({ variantId: variant.id, quantity: 1 })
      .expect(201);
    await prisma.stockItem.update({ where: { id: stockItem.id }, data: { onHand: 0 } });

    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout/quote')
      .set('X-Cart-Token', token)
      .send({ country: 'EG', shippingRateId: rate.id })
      .expect(201);

    expect(res.body.issues).toHaveLength(1);
    expect(res.body.subtotal).toBe(0);
  });
});
