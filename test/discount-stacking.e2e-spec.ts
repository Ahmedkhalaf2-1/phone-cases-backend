import { INestApplication } from '@nestjs/common';
import { CouponType, StaffRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

/**
 * Regression coverage for combined bundle+coupon discount stacking
 * (CartPricingService.buildView, bundle-pricing.util.ts,
 * OrdersService.createOrder's per-line allocation) - see
 * docs/BUSINESS_RULES.md and docs/DECISIONS.md for the fixed policy:
 * bundle discounts apply first, and an allowed-to-stack coupon only ever
 * discounts what bundles left eligible.
 */
describe('Bundle + coupon discount stacking correctness (e2e)', () => {
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

  async function seedTwoPhoneModels() {
    const brand = await prisma.phoneBrand.create({
      data: { slug: `brand-${Date.now()}-${Math.random()}`, nameEn: 'Brand', nameAr: 'ماركة' },
    });
    const modelA = await prisma.phoneModel.create({
      data: {
        slug: `model-a-${Date.now()}-${Math.random()}`,
        nameEn: 'Model A',
        nameAr: 'موديل أ',
        brandId: brand.id,
      },
    });
    const modelB = await prisma.phoneModel.create({
      data: {
        slug: `model-b-${Date.now()}-${Math.random()}`,
        nameEn: 'Model B',
        nameAr: 'موديل ب',
        brandId: brand.id,
      },
    });
    return { modelA, modelB };
  }

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

  async function createBundle(overrides: Record<string, unknown>): Promise<void> {
    await request(app.getHttpServer())
      .post('/api/v1/admin/bundles')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Test bundle', ...overrides })
      .expect(201);
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

  it('computes the coupon on the amount remaining after an allowed-to-stack bundle discount, at the cart level', async () => {
    // subtotal 20000 (2 units), bundle fixedTotal 10000 -> bundle discount
    // 10000; a 75% coupon on the REMAINING 10000 -> 7500; final total
    // 20000 - 7500 - 10000 = 2500. Fixtures only, not a real offer.
    const { modelA, modelB } = await seedTwoPhoneModels();
    const variantA = await seedVariant(10000, modelA.id);
    const variantB = await seedVariant(10000, modelB.id);
    await createBundle({
      fixedTotal: 10000,
      currency: 'EGP',
      isEnabled: true,
      allowCouponStacking: true,
      eligibleVariants: [{ variantId: variantA.id }, { variantId: variantB.id }],
    });
    await prisma.coupon.create({
      data: { code: 'SEVENTYFIVE', type: CouponType.PERCENTAGE, value: 75 },
    });

    const token = await createCartWithItems([variantA.id, variantB.id]);
    await request(app.getHttpServer())
      .post('/api/v1/cart/coupon')
      .set('X-Cart-Token', token)
      .send({ code: 'SEVENTYFIVE' })
      .expect(201);

    const cart = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('X-Cart-Token', token)
      .expect(200);

    expect(cart.body.subtotal).toBe(20000);
    expect(cart.body.bundleDiscountTotal).toBe(10000);
    expect(cart.body.discountTotal).toBe(7500);
    expect(cart.body.total).toBe(2500);
    // Never negative, and never more than the merchandise subtotal.
    expect(cart.body.total).toBeGreaterThanOrEqual(0);
  });

  it('produces the identical total in the checkout quote and the created order', async () => {
    const { modelA, modelB } = await seedTwoPhoneModels();
    const variantA = await seedVariant(10000, modelA.id);
    const variantB = await seedVariant(10000, modelB.id);
    await createBundle({
      fixedTotal: 10000,
      currency: 'EGP',
      isEnabled: true,
      allowCouponStacking: true,
      eligibleVariants: [{ variantId: variantA.id }, { variantId: variantB.id }],
    });
    await prisma.coupon.create({
      data: { code: 'SEVENTYFIVE', type: CouponType.PERCENTAGE, value: 75 },
    });
    const zone = await prisma.shippingZone.create({
      data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
    });
    const rate = await prisma.shippingRate.create({
      data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price: 5000 },
    });

    const token = await createCartWithItems([variantA.id, variantB.id]);
    await request(app.getHttpServer())
      .post('/api/v1/cart/coupon')
      .set('X-Cart-Token', token)
      .send({ code: 'SEVENTYFIVE' })
      .expect(201);

    const quote = await request(app.getHttpServer())
      .post('/api/v1/checkout/quote')
      .set('X-Cart-Token', token)
      .send({ country: 'EG', shippingRateId: rate.id })
      .expect(201);
    expect(quote.body.discountTotal).toBe(7500);
    expect(quote.body.bundleDiscountTotal).toBe(10000);
    expect(quote.body.total).toBe(2500 + 5000);

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

    expect(orderRes.body.discountTotal).toBe(7500);
    expect(orderRes.body.bundleDiscountTotal).toBe(10000);
    expect(orderRes.body.total).toBe(2500 + 5000);

    // Every line total must be non-negative and the allocations must sum
    // exactly to the recorded order-level discounts.
    const items = orderRes.body.items as {
      lineSubtotal: number;
      lineDiscount: number;
      bundleDiscount: number;
      lineTotal: number;
    }[];
    for (const item of items) {
      expect(item.lineTotal).toBeGreaterThanOrEqual(0);
      expect(item.lineDiscount + item.bundleDiscount).toBeLessThanOrEqual(item.lineSubtotal);
    }
    expect(items.reduce((sum, i) => sum + i.lineDiscount, 0)).toBe(7500);
    expect(items.reduce((sum, i) => sum + i.bundleDiscount, 0)).toBe(10000);
  });

  it('caps a fixed coupon at the amount remaining after the bundle discount, never going negative', async () => {
    const { modelA, modelB } = await seedTwoPhoneModels();
    const variantA = await seedVariant(10000, modelA.id);
    const variantB = await seedVariant(10000, modelB.id);
    await createBundle({
      fixedTotal: 10000,
      currency: 'EGP',
      isEnabled: true,
      allowCouponStacking: true,
      eligibleVariants: [{ variantId: variantA.id }, { variantId: variantB.id }],
    });
    // Remaining eligible amount after the bundle is 10000; this FIXED
    // coupon (15000) exceeds it and must be capped, not overshoot.
    await prisma.coupon.create({
      data: { code: 'BIGFIXED', type: CouponType.FIXED, value: 15000 },
    });

    const token = await createCartWithItems([variantA.id, variantB.id]);
    await request(app.getHttpServer())
      .post('/api/v1/cart/coupon')
      .set('X-Cart-Token', token)
      .send({ code: 'BIGFIXED' })
      .expect(201);

    const cart = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('X-Cart-Token', token)
      .expect(200);

    expect(cart.body.discountTotal).toBe(10000);
    expect(cart.body.bundleDiscountTotal).toBe(10000);
    expect(cart.body.total).toBe(0);
  });

  it('never applies a bundle discount together with a coupon when that bundle disallows stacking, preserving the original coupon-only behavior', async () => {
    const { modelA, modelB } = await seedTwoPhoneModels();
    const variantA = await seedVariant(10000, modelA.id);
    const variantB = await seedVariant(10000, modelB.id);
    await createBundle({
      fixedTotal: 10000,
      currency: 'EGP',
      isEnabled: true,
      allowCouponStacking: false,
      eligibleVariants: [{ variantId: variantA.id }, { variantId: variantB.id }],
    });
    await prisma.coupon.create({
      data: { code: 'NOSTACK', type: CouponType.PERCENTAGE, value: 10 },
    });

    const token = await createCartWithItems([variantA.id, variantB.id]);
    await request(app.getHttpServer())
      .post('/api/v1/cart/coupon')
      .set('X-Cart-Token', token)
      .send({ code: 'NOSTACK' })
      .expect(201);

    const cart = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('X-Cart-Token', token)
      .expect(200);

    // The bundle is skipped entirely while a coupon is applied; the
    // coupon discounts the FULL subtotal, exactly as before this fix.
    expect(cart.body.bundleDiscountTotal).toBe(0);
    expect(cart.body.discountTotal).toBe(2000); // 10% of 20000
    expect(cart.body.total).toBe(18000);
  });

  it('never lets two overlapping bundles both discount the same physical units, end to end', async () => {
    const { modelA, modelB } = await seedTwoPhoneModels();
    const variantA = await seedVariant(30000, modelA.id);
    const variantB = await seedVariant(35000, modelB.id);
    // Two DIFFERENT active bundles, both eligible for the same pair, only
    // one unit of each variant in the cart.
    await createBundle({
      name: 'Bundle one',
      fixedTotal: 50000,
      currency: 'EGP',
      isEnabled: true,
      eligibleVariants: [{ variantId: variantA.id }, { variantId: variantB.id }],
    });
    await createBundle({
      name: 'Bundle two',
      fixedTotal: 40000,
      currency: 'EGP',
      isEnabled: true,
      eligibleVariants: [{ variantId: variantA.id }, { variantId: variantB.id }],
    });

    const token = await createCartWithItems([variantA.id, variantB.id]);
    const cart = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('X-Cart-Token', token)
      .expect(200);

    // Only ONE bundle instance can ever form from a single physical pair
    // - the earliest-configured bundle (bundle one, fixedTotal 50000,
    // discount 15000) wins; bundle two gets nothing since no units are
    // left. Total savings must be 15000, never 15000+25000.
    expect(cart.body.bundleDiscountTotal).toBe(15000);
    expect(cart.body.total).toBe(65000 - 15000);
  });
});
