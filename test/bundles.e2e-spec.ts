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
});
