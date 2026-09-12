import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

/**
 * Requirement under test: a ProductVariant with no linked StockItem must
 * NOT be treated as available by default - unlimited availability is only
 * ever true when a staff member has explicitly set `isUnlimitedStock` to
 * true. See docs/BUSINESS_RULES.md and docs/DECISIONS.md. This is checked
 * end-to-end: public catalog visibility, adding to a cart, and checking
 * out - since all three had their own independent (and, before this
 * fix, inconsistent) implementation of the old "no StockItem = always
 * available" assumption.
 */
describe('Explicit unlimited-stock opt-in (e2e)', () => {
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

  async function createDraftProduct(slug: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/admin/products')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ slug, nameEn: 'Space', nameAr: 'الفضاء' })
      .expect(201);
    return res.body.id as string;
  }

  async function publishProduct(productId: string): Promise<void> {
    // Publishing requires >=1 active variant - see docs/BUSINESS_RULES.md
    // §2 - so this must only be called after at least one variant exists.
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${productId}/status`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ status: 'PUBLISHED' })
      .expect(200);
  }

  describe('database default', () => {
    it('defaults isUnlimitedStock to false for a newly created variant', async () => {
      const productId = await createDraftProduct('default-check');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${productId}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ sku: 'DEFAULT-1', price: 1000 })
        .expect(201);

      const variant = await prisma.productVariant.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(variant.stockItemId).toBeNull();
      expect(variant.isUnlimitedStock).toBe(false);
    });
  });

  describe('admin validation', () => {
    it('rejects setting isUnlimitedStock:true together with a stockItemId', async () => {
      const productId = await createDraftProduct('contradiction-check');
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-CONTRADICT', nameEn: 'Blank', onHand: 5 },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${productId}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          sku: 'CONTRADICT-1',
          price: 1000,
          stockItemId: stockItem.id,
          isUnlimitedStock: true,
        })
        .expect(400);
    });
  });

  describe('a variant with no StockItem and isUnlimitedStock left at its default (false)', () => {
    async function seedNotOptedInVariant() {
      const productId = await createDraftProduct('not-opted-in');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${productId}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ sku: 'NOT-OPTED-IN-1', price: 1000 })
        .expect(201);
      await publishProduct(productId);
      return created.body.id as string;
    }

    it('is NOT available in the public product detail', async () => {
      await seedNotOptedInVariant();
      const res = await request(app.getHttpServer())
        .get('/api/v1/products/not-opted-in')
        .expect(200);
      expect(res.body.isAvailable).toBe(false);
      expect(res.body.variants[0].isAvailable).toBe(false);
    });

    it('cannot be added to a cart', async () => {
      const variantId = await seedNotOptedInVariant();
      const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
      const token = cartRes.body.token as string;

      const res = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId, quantity: 1 })
        .expect(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
    });
  });

  describe('a variant with no StockItem and isUnlimitedStock explicitly set to true', () => {
    async function seedOptedInVariant() {
      const productId = await createDraftProduct('opted-in');
      const created = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${productId}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ sku: 'OPTED-IN-1', price: 1000, isUnlimitedStock: true })
        .expect(201);
      await publishProduct(productId);
      return created.body.id as string;
    }

    it('is available in the public product detail', async () => {
      await seedOptedInVariant();
      const res = await request(app.getHttpServer()).get('/api/v1/products/opted-in').expect(200);
      expect(res.body.isAvailable).toBe(true);
      expect(res.body.variants[0].isAvailable).toBe(true);
    });

    it('can be added to a cart and checked out into an order', async () => {
      const variantId = await seedOptedInVariant();
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
        .send({ variantId, quantity: 2 })
        .expect(201);

      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('X-Cart-Token', token)
        .send({ country: 'EG', shippingRateId: rate.id })
        .expect(201);
      expect(quote.body.issues).toEqual([]);
      expect(quote.body.subtotal).toBe(2000);

      const order = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send({
          idempotencyKey: `unlimited-stock-${Date.now()}`,
          customerFullName: 'Test Customer',
          customerPhone: '01012345678',
          shippingCountry: 'EG',
          shippingCity: 'Cairo',
          shippingAddressLine1: 'Test St',
          shippingRateId: rate.id,
          expectedTotal: quote.body.total,
        })
        .expect(201);
      expect(order.body.subtotal).toBe(2000);

      // No StockItem exists at all for this variant, so no reservation
      // should ever be created for it - there is nothing to reserve.
      const reservationCount = await prisma.stockReservation.count();
      expect(reservationCount).toBe(0);
    });
  });
});
