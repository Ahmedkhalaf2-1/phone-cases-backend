import { INestApplication } from '@nestjs/common';
import { CouponType, StaffRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

describe('Bundles (e2e)', () => {
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
    ({ accessToken } = await createStaffAndLogin(app, StaffRole.CATALOG_MANAGER));
  });

  async function seedVariant(price: number, phoneModelId: string | null) {
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
        phoneModelId: phoneModelId ?? undefined,
        isUnlimitedStock: true,
      },
    });
  }

  async function seedTwoPhoneModels() {
    const brand = await prisma.phoneBrand.create({
      data: { slug: `brand-${Date.now()}`, nameEn: 'Brand', nameAr: 'ماركة' },
    });
    const modelA = await prisma.phoneModel.create({
      data: {
        slug: `model-a-${Date.now()}`,
        nameEn: 'Model A',
        nameAr: 'موديل أ',
        brandId: brand.id,
      },
    });
    const modelB = await prisma.phoneModel.create({
      data: {
        slug: `model-b-${Date.now()}`,
        nameEn: 'Model B',
        nameAr: 'موديل ب',
        brandId: brand.id,
      },
    });
    return { modelA, modelB };
  }

  async function createCartWithItems(variantIds: string[]) {
    const cartRes = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
    const token = cartRes.body.token as string;
    for (const variantId of variantIds) {
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId, quantity: 1 })
        .expect(201);
    }
    return token;
  }

  function createBundlePayload(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Two-model bundle',
      ...overrides,
    };
  }

  describe('activation readiness', () => {
    it('refuses to enable a bundle with no fixedTotal/currency configured', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/bundles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(createBundlePayload({ isEnabled: true }))
        .expect(400);
    });

    it('refuses to enable a bundle with fewer than two eligible variants', async () => {
      const { modelA } = await seedTwoPhoneModels();
      const variantA = await seedVariant(30000, modelA.id);
      await request(app.getHttpServer())
        .post('/api/v1/admin/bundles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(
          createBundlePayload({
            fixedTotal: 50000,
            currency: 'EGP',
            isEnabled: true,
            eligibleVariants: [{ variantId: variantA.id }],
          }),
        )
        .expect(400);
    });

    it('refuses to enable a phone-model-diverse bundle whose eligible variants share the same phone model', async () => {
      const { modelA } = await seedTwoPhoneModels();
      const variantA = await seedVariant(30000, modelA.id);
      const variantA2 = await seedVariant(32000, modelA.id);
      await request(app.getHttpServer())
        .post('/api/v1/admin/bundles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(
          createBundlePayload({
            fixedTotal: 50000,
            currency: 'EGP',
            isEnabled: true,
            eligibleVariants: [{ variantId: variantA.id }, { variantId: variantA2.id }],
          }),
        )
        .expect(400);
    });

    it('enables a fully configured bundle spanning two phone models', async () => {
      const { modelA, modelB } = await seedTwoPhoneModels();
      const variantA = await seedVariant(30000, modelA.id);
      const variantB = await seedVariant(35000, modelB.id);
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/bundles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(
          createBundlePayload({
            fixedTotal: 50000,
            currency: 'EGP',
            isEnabled: true,
            eligibleVariants: [{ variantId: variantA.id }, { variantId: variantB.id }],
          }),
        )
        .expect(201);
      expect(created.body.isEnabled).toBe(true);
    });
  });

  describe('cart and order pricing integration', () => {
    it('discounts a cart with one unit of each eligible variant down to the fixed total', async () => {
      const { modelA, modelB } = await seedTwoPhoneModels();
      const variantA = await seedVariant(30000, modelA.id);
      const variantB = await seedVariant(35000, modelB.id);
      await request(app.getHttpServer())
        .post('/api/v1/admin/bundles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(
          createBundlePayload({
            fixedTotal: 50000,
            currency: 'EGP',
            isEnabled: true,
            eligibleVariants: [{ variantId: variantA.id }, { variantId: variantB.id }],
          }),
        )
        .expect(201);

      const token = await createCartWithItems([variantA.id, variantB.id]);
      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('X-Cart-Token', token)
        .expect(200);

      expect(cart.body.subtotal).toBe(65000);
      expect(cart.body.bundleDiscountTotal).toBe(15000);
      expect(cart.body.total).toBe(50000);
      const itemBundleDiscountSum = cart.body.items.reduce(
        (sum: number, item: { bundleDiscount: number }) => sum + item.bundleDiscount,
        0,
      );
      expect(itemBundleDiscountSum).toBe(15000);
    });

    it('creates an order with a persisted BundleInstance and per-line bundleDiscount snapshots', async () => {
      const { modelA, modelB } = await seedTwoPhoneModels();
      const variantA = await seedVariant(30000, modelA.id);
      const variantB = await seedVariant(35000, modelB.id);
      const bundleRes = await request(app.getHttpServer())
        .post('/api/v1/admin/bundles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(
          createBundlePayload({
            fixedTotal: 50000,
            currency: 'EGP',
            isEnabled: true,
            eligibleVariants: [{ variantId: variantA.id }, { variantId: variantB.id }],
          }),
        )
        .expect(201);

      const zone = await prisma.shippingZone.create({
        data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
      });
      const rate = await prisma.shippingRate.create({
        data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price: 5000 },
      });

      const token = await createCartWithItems([variantA.id, variantB.id]);
      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('X-Cart-Token', token)
        .send({ country: 'EG', shippingRateId: rate.id })
        .expect(201);
      expect(quote.body.bundleDiscountTotal).toBe(15000);
      expect(quote.body.total).toBe(55000);

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

      expect(orderRes.body.bundleDiscountTotal).toBe(15000);
      expect(orderRes.body.total).toBe(55000);
      const bundledItems = orderRes.body.items.filter(
        (item: { bundleDiscount: number }) => item.bundleDiscount > 0,
      );
      expect(bundledItems).toHaveLength(2);
      const sumBundleDiscount = orderRes.body.items.reduce(
        (sum: number, item: { bundleDiscount: number }) => sum + item.bundleDiscount,
        0,
      );
      expect(sumBundleDiscount).toBe(15000);

      const instances = await prisma.bundleInstance.findMany({
        where: { bundlePromotionId: bundleRes.body.id },
      });
      expect(instances).toHaveLength(1);
      expect(instances[0].discountAmount).toBe(15000);
      expect(instances[0].normalSubtotal).toBe(65000);
      expect(instances[0].fixedTotalApplied).toBe(50000);

      const linkedItems = await prisma.orderItem.findMany({
        where: { bundleInstanceId: instances[0].id },
      });
      expect(linkedItems).toHaveLength(2);
    });

    it('skips the bundle discount entirely when a coupon is applied and stacking is not allowed', async () => {
      const { modelA, modelB } = await seedTwoPhoneModels();
      const variantA = await seedVariant(30000, modelA.id);
      const variantB = await seedVariant(35000, modelB.id);
      await request(app.getHttpServer())
        .post('/api/v1/admin/bundles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(
          createBundlePayload({
            fixedTotal: 50000,
            currency: 'EGP',
            isEnabled: true,
            allowCouponStacking: false,
            eligibleVariants: [{ variantId: variantA.id }, { variantId: variantB.id }],
          }),
        )
        .expect(201);
      await prisma.coupon.create({
        data: { code: 'STACK10', type: CouponType.PERCENTAGE, value: 10 },
      });

      const token = await createCartWithItems([variantA.id, variantB.id]);
      await request(app.getHttpServer())
        .post('/api/v1/cart/coupon')
        .set('X-Cart-Token', token)
        .send({ code: 'STACK10' })
        .expect(201);

      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('X-Cart-Token', token)
        .expect(200);

      expect(cart.body.bundleDiscountTotal).toBe(0);
      expect(cart.body.discountTotal).toBe(6500);
      expect(cart.body.total).toBe(58500);
    });

    it('never lets a misconfigured bundle increase the payable total', async () => {
      const { modelA, modelB } = await seedTwoPhoneModels();
      const variantA = await seedVariant(10000, modelA.id);
      const variantB = await seedVariant(10000, modelB.id);
      // fixedTotal (50000) far exceeds the normal 20000 combined price.
      await request(app.getHttpServer())
        .post('/api/v1/admin/bundles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(
          createBundlePayload({
            fixedTotal: 50000,
            currency: 'EGP',
            isEnabled: true,
            eligibleVariants: [{ variantId: variantA.id }, { variantId: variantB.id }],
          }),
        )
        .expect(201);

      const token = await createCartWithItems([variantA.id, variantB.id]);
      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('X-Cart-Token', token)
        .expect(200);

      expect(cart.body.bundleDiscountTotal).toBe(0);
      expect(cart.body.total).toBe(20000);
    });
  });
  describe('eligibility scopes', () => {
    const anyTwoFor450 = {
      name: 'Any 2 for 450',
      fixedTotal: 45000,
      currency: 'EGP',
      scope: 'ALL_PRODUCTS',
      requireDifferentPhoneModels: false,
      isEnabled: true,
    };

    function postBundle(body: Record<string, unknown>) {
      return request(app.getHttpServer())
        .post('/api/v1/admin/bundles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(body);
    }

    it('defaults to SPECIFIC_VARIANTS with a bundle size of 2 (backward compatible)', async () => {
      const created = await postBundle({ name: 'Legacy shape' }).expect(201);
      expect(created.body.scope).toBe('SPECIFIC_VARIANTS');
      expect(created.body.bundleSize).toBe(2);
      expect(created.body.targets).toEqual([]);
    });

    it('ALL_PRODUCTS stores no ids and applies to products created after the bundle', async () => {
      const created = await postBundle(anyTwoFor450).expect(201);
      expect(created.body.scope).toBe('ALL_PRODUCTS');
      expect(created.body.eligibleVariants).toEqual([]);

      // Created AFTER the bundle - never listed anywhere.
      const first = await seedVariant(30000, null);
      const second = await seedVariant(30000, null);
      const token = await createCartWithItems([first.id, second.id]);
      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('X-Cart-Token', token)
        .expect(200);
      expect(cart.body.subtotal).toBe(60000);
      expect(cart.body.bundleDiscountTotal).toBe(15000);
      expect(cart.body.total).toBe(45000);
    });

    it('never charges more than the normal price for a cheap pair', async () => {
      await postBundle(anyTwoFor450).expect(201);
      const first = await seedVariant(20000, null);
      const second = await seedVariant(20000, null);
      const token = await createCartWithItems([first.id, second.id]);
      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('X-Cart-Token', token)
        .expect(200);
      expect(cart.body.bundleDiscountTotal).toBe(0);
      expect(cart.body.total).toBe(40000);
    });

    it('rejects ALL_PRODUCTS combined with eligible variants or target ids', async () => {
      const variant = await seedVariant(30000, null);
      await postBundle({
        ...anyTwoFor450,
        isEnabled: false,
        eligibleVariants: [{ variantId: variant.id }],
      }).expect(400);
      await postBundle({
        ...anyTwoFor450,
        isEnabled: false,
        targetIds: ['3f2b0b52-6c7b-4f55-9c52-0d6f0a6f8a11'],
      }).expect(400);
    });

    it('rejects out-of-range and duplicate input with 400 instead of a server error', async () => {
      const variant = await seedVariant(30000, null);
      const manyIds = Array.from(
        { length: 1001 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
      await postBundle({ ...anyTwoFor450, isEnabled: false, bundleSize: 51 }).expect(400);
      await postBundle({ ...anyTwoFor450, isEnabled: false, bundleSize: 3_000_000_000 }).expect(
        400,
      );
      await postBundle({ ...anyTwoFor450, isEnabled: false, fixedTotal: 3_000_000_000 }).expect(
        400,
      );
      await postBundle({
        ...anyTwoFor450,
        isEnabled: false,
        scope: 'SPECIFIC_VARIANTS',
        eligibleVariants: [{ variantId: variant.id }, { variantId: variant.id }],
      }).expect(400);
      await postBundle({
        ...anyTwoFor450,
        isEnabled: false,
        scope: 'SPECIFIC_VARIANTS',
        eligibleVariants: manyIds.map((variantId) => ({ variantId })),
      }).expect(400);
    });

    it('rejects target ids that do not exist', async () => {
      await postBundle({
        ...anyTwoFor450,
        scope: 'COLLECTIONS',
        targetIds: ['3f2b0b52-6c7b-4f55-9c52-0d6f0a6f8a11'],
      }).expect(400);
    });

    it('COLLECTIONS scope only discounts products in the chosen collection', async () => {
      const collection = await prisma.collection.create({
        data: { slug: `col-${Date.now()}`, nameEn: 'Anime', nameAr: 'انمي' },
      });
      const inCollection = await seedVariant(30000, null);
      const outside = await seedVariant(30000, null);
      await prisma.productCollection.create({
        data: { productId: inCollection.productId, collectionId: collection.id },
      });

      await postBundle({
        ...anyTwoFor450,
        scope: 'COLLECTIONS',
        targetIds: [collection.id],
      }).expect(201);

      const token = await createCartWithItems([inCollection.id, outside.id]);
      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('X-Cart-Token', token)
        .expect(200);
      expect(cart.body.bundleDiscountTotal).toBe(0);

      const second = await seedVariant(30000, null);
      await prisma.productCollection.create({
        data: { productId: second.productId, collectionId: collection.id },
      });
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: second.id, quantity: 1 })
        .expect(201);
      const updated = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('X-Cart-Token', token)
        .expect(200);
      expect(updated.body.bundleDiscountTotal).toBe(15000);
    });

    it('returns every matching id for select-all, and labels for a selection by id', async () => {
      const first = await seedVariant(30000, null);
      const second = await seedVariant(30000, null);
      const ids = await request(app.getHttpServer())
        .get('/api/v1/admin/bundles/variant-options/ids')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(ids.body.total).toBe(2);
      expect(ids.body.ids.sort()).toEqual([first.id, second.id].sort());
      expect(ids.body.truncated).toBeUndefined();

      const labels = await request(app.getHttpServer())
        .get(`/api/v1/admin/bundles/variant-options/by-ids?ids=${first.id},${second.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(labels.body).toHaveLength(2);
      expect(labels.body[0].product.nameEn).toBe('Case');
      await request(app.getHttpServer())
        .get('/api/v1/admin/bundles/variant-options/by-ids?ids=not-a-uuid')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });

    it('lists variant options with filters and pagination', async () => {
      const variant = await seedVariant(30000, null);
      await seedVariant(30000, null);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/admin/bundles/variant-options?productId=${variant.productId}&pageSize=10`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body.meta.totalItems).toBe(1);
      expect(res.body.items[0].id).toBe(variant.id);
      expect(res.body.items[0].product.nameEn).toBe('Case');
    });
  });
  describe('scheduling', () => {
    const base = {
      name: 'Scheduled',
      fixedTotal: 45000,
      currency: 'EGP',
      scope: 'ALL_PRODUCTS',
      requireDifferentPhoneModels: false,
    };
    const post = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/api/v1/admin/bundles')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...base, ...body });
    const patch = (id: string, body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .patch(`/api/v1/admin/bundles/${id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(body);

    it('creates with a valid start and end, start only, and end only', async () => {
      const both = await post({
        startsAt: '2026-11-01T00:00:00Z',
        expiresAt: '2026-12-01T00:00:00Z',
      }).expect(201);
      expect(both.body.startsAt).toBe('2026-11-01T00:00:00.000Z');
      expect(both.body.expiresAt).toBe('2026-12-01T00:00:00.000Z');
      const startOnly = await post({ startsAt: '2026-11-01T00:00:00Z' }).expect(201);
      expect(startOnly.body.expiresAt).toBeNull();
      const endOnly = await post({ expiresAt: '2026-12-01T00:00:00Z' }).expect(201);
      expect(endOnly.body.startsAt).toBeNull();
    });

    it('rejects expiresAt before or equal to startsAt on create', async () => {
      await post({ startsAt: '2026-12-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z' }).expect(
        400,
      );
      await post({ startsAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z' }).expect(
        400,
      );
    });

    it('clears start, end, and both with null on PATCH', async () => {
      const created = await post({
        startsAt: '2026-11-01T00:00:00Z',
        expiresAt: '2026-12-01T00:00:00Z',
      }).expect(201);
      const id = created.body.id as string;

      const noStart = await patch(id, { startsAt: null }).expect(200);
      expect(noStart.body.startsAt).toBeNull();
      expect(noStart.body.expiresAt).toBe('2026-12-01T00:00:00.000Z');

      await patch(id, { startsAt: '2026-11-01T00:00:00Z' }).expect(200);
      const noEnd = await patch(id, { expiresAt: null }).expect(200);
      expect(noEnd.body.expiresAt).toBeNull();
      expect(noEnd.body.startsAt).toBe('2026-11-01T00:00:00.000Z');

      const neither = await patch(id, { startsAt: null, expiresAt: null }).expect(200);
      expect(neither.body.startsAt).toBeNull();
      expect(neither.body.expiresAt).toBeNull();
    });

    it('reports a server-computed lifecycle status', async () => {
      const scheduled = await post({ isEnabled: true, startsAt: '2099-01-01T00:00:00Z' }).expect(
        201,
      );
      expect(scheduled.body.status).toBe('SCHEDULED');
      const expired = await post({ isEnabled: true, expiresAt: '2020-01-01T00:00:00Z' }).expect(
        201,
      );
      expect(expired.body.status).toBe('EXPIRED');
      const active = await post({ isEnabled: true }).expect(201);
      expect(active.body.status).toBe('ACTIVE');
      const disabled = await post({}).expect(201);
      expect(disabled.body.status).toBe('DISABLED');
    });

    it('an unrelated PATCH leaves the schedule untouched', async () => {
      const created = await post({
        startsAt: '2026-11-01T00:00:00Z',
        expiresAt: '2026-12-01T00:00:00Z',
      }).expect(201);
      const renamed = await patch(created.body.id, { name: 'Renamed' }).expect(200);
      expect(renamed.body.startsAt).toBe('2026-11-01T00:00:00.000Z');
      expect(renamed.body.expiresAt).toBe('2026-12-01T00:00:00.000Z');
    });

    it('rejects a PATCH that would invalidate the persisted range', async () => {
      const created = await post({
        startsAt: '2026-11-01T00:00:00Z',
        expiresAt: '2026-12-01T00:00:00Z',
      }).expect(201);
      const id = created.body.id as string;
      await patch(id, { startsAt: '2026-12-15T00:00:00Z' }).expect(400);
      await patch(id, { expiresAt: '2026-10-01T00:00:00Z' }).expect(400);
      await patch(id, { expiresAt: '2026-11-01T00:00:00Z' }).expect(400);
      const unchanged = await request(app.getHttpServer())
        .get(`/api/v1/admin/bundles/${id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(unchanged.body.startsAt).toBe('2026-11-01T00:00:00.000Z');
      expect(unchanged.body.expiresAt).toBe('2026-12-01T00:00:00.000Z');
    });
  });
});
