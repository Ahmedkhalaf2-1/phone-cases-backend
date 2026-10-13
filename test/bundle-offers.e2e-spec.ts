import { INestApplication } from '@nestjs/common';
import { CouponType, StaffRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

/**
 * Storefront-facing bundle data: the public offers endpoint and the
 * bundleProgress block on the cart. Everything here is display data -
 * the discount itself is covered by bundles.e2e-spec.ts.
 */
describe('Bundle offers for the storefront (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  let seq = 0;

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

  async function seedVariant(
    price: number,
    opts: { modelId?: string; collectionId?: string } = {},
  ) {
    seq += 1;
    const product = await prisma.product.create({
      data: {
        slug: `offer-p-${seq}-${Date.now()}`,
        nameEn: `Case ${seq}`,
        nameAr: 'جراب',
        status: 'PUBLISHED',
      },
    });
    if (opts.collectionId) {
      await prisma.productCollection.create({
        data: { productId: product.id, collectionId: opts.collectionId },
      });
    }
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `OFFER-${seq}-${Date.now()}`,
        price,
        phoneModelId: opts.modelId,
        isUnlimitedStock: true,
      },
    });
    return { product, variant };
  }

  const createBundle = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/bundles')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'INTERNAL NAME - must never reach customers',
        fixedTotal: 45000,
        currency: 'EGP',
        scope: 'ALL_PRODUCTS',
        requireDifferentPhoneModels: false,
        isEnabled: true,
        ...body,
      });

  async function cartWith(variantIds: string[], couponCode?: string) {
    const created = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
    const token = created.body.token as string;
    for (const variantId of variantIds) {
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId, quantity: 1 })
        .expect(201);
    }
    if (couponCode) {
      await request(app.getHttpServer())
        .post('/api/v1/cart/coupon')
        .set('X-Cart-Token', token)
        .send({ code: couponCode })
        .expect(201);
    }
    return request(app.getHttpServer()).get('/api/v1/cart').set('X-Cart-Token', token).expect(200);
  }

  describe('GET /bundles/active', () => {
    it('is public and empty when nothing is active', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/bundles/active').expect(200);
      expect(res.body).toEqual([]);
    });

    it('describes an all-products offer without leaking internal fields', async () => {
      await seedVariant(25000);
      await seedVariant(30000);
      await createBundle({}).expect(201);

      const res = await request(app.getHttpServer()).get('/api/v1/bundles/active').expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toEqual({
        bundleSize: 2,
        fixedTotal: 45000,
        currency: 'EGP',
        scope: 'ALL_PRODUCTS',
        requireDifferentPhoneModels: false,
        isRepeatable: true,
        allowCouponStacking: false,
        minSavings: 5000, // 2 x 250 (cheapest eligible) - 450, provable
        appliesTo: { type: 'ALL' },
        announcementBanner: null,
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('INTERNAL NAME');
      expect(res.body[0]).not.toHaveProperty('id');
      expect(res.body[0]).not.toHaveProperty('name');
    });

    it('reports minSavings 0 when a saving cannot be proven', async () => {
      await seedVariant(20000); // two of the cheapest cost 400 < 450
      await createBundle({}).expect(201);
      const res = await request(app.getHttpServer()).get('/api/v1/bundles/active').expect(200);
      expect(res.body[0].minSavings).toBe(0);
    });

    it('resolves a collection offer to the product slugs that can actually be bought', async () => {
      const collection = await prisma.collection.create({
        data: { slug: `c-${Date.now()}`, nameEn: 'Anime', nameAr: 'انمي' },
      });
      const inside = await seedVariant(25000, { collectionId: collection.id });
      await seedVariant(25000); // outside the collection
      await createBundle({ scope: 'COLLECTIONS', targetIds: [collection.id] }).expect(201);

      const res = await request(app.getHttpServer()).get('/api/v1/bundles/active').expect(200);
      expect(res.body[0].appliesTo).toEqual({
        type: 'SELECTED',
        productSlugs: [inside.product.slug],
      });
    });

    it('lists only enabled offers and reflects admin edits immediately', async () => {
      await seedVariant(25000);
      const created = await createBundle({ isEnabled: false }).expect(201);
      let res = await request(app.getHttpServer()).get('/api/v1/bundles/active').expect(200);
      expect(res.body).toEqual([]);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/bundles/${created.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ isEnabled: true })
        .expect(200);
      res = await request(app.getHttpServer()).get('/api/v1/bundles/active').expect(200);
      expect(res.body).toHaveLength(1);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/bundles/${created.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ fixedTotal: 40000 })
        .expect(200);
      res = await request(app.getHttpServer()).get('/api/v1/bundles/active').expect(200);
      expect(res.body[0].fixedTotal).toBe(40000);
    });
  });

  describe('announcement banner', () => {
    const activeOffers = async () =>
      (await request(app.getHttpServer()).get('/api/v1/bundles/active').expect(200)).body as Array<{
        announcementBanner: null | {
          enabled: boolean;
          text: string;
          ctaLabel: string;
          target: { type: string; href: string };
        };
      }>;
    const hour = 60 * 60 * 1000;

    it('is off by default: an active bundle has no banner', async () => {
      await seedVariant(25000);
      await createBundle({}).expect(201);
      const offers = await activeOffers();
      expect(offers).toHaveLength(1);
      expect(offers[0].announcementBanner).toBeNull();
    });

    it('uses a generated default text and CTA when none is configured', async () => {
      await seedVariant(25000);
      await createBundle({ showAnnouncementBanner: true }).expect(201);
      const [offer] = await activeOffers();
      expect(offer.announcementBanner).toEqual({
        enabled: true,
        text: '2 CASES FOR 450 EGP',
        ctaLabel: 'SHOP NOW',
        target: { type: 'CATALOG', href: '/collections' },
      });
    });

    it('uses admin text and CTA, trims them, and clears them with blank values', async () => {
      await seedVariant(25000);
      const created = await createBundle({
        showAnnouncementBanner: true,
        bannerText: '  BUY 2, SAVE BIG  ',
        bannerCtaLabel: 'GET IT',
      }).expect(201);
      let [offer] = await activeOffers();
      expect(offer.announcementBanner).toMatchObject({
        text: 'BUY 2, SAVE BIG',
        ctaLabel: 'GET IT',
      });

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/bundles/${created.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ bannerText: '   ', bannerCtaLabel: null })
        .expect(200);
      [offer] = await activeOffers();
      expect(offer.announcementBanner).toMatchObject({
        text: '2 CASES FOR 450 EGP',
        ctaLabel: 'SHOP NOW',
      });
    });

    it('turning the flag off removes the banner but keeps the offer', async () => {
      await seedVariant(25000);
      const created = await createBundle({ showAnnouncementBanner: true }).expect(201);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/bundles/${created.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ showAnnouncementBanner: false })
        .expect(200);
      const offers = await activeOffers();
      expect(offers).toHaveLength(1);
      expect(offers[0].announcementBanner).toBeNull();
    });

    it('never shows a banner for inactive, scheduled or expired bundles', async () => {
      await seedVariant(25000);
      await createBundle({ showAnnouncementBanner: true, isEnabled: false }).expect(201);
      await createBundle({
        showAnnouncementBanner: true,
        startsAt: new Date(Date.now() + hour).toISOString(),
      }).expect(201);
      await createBundle({
        showAnnouncementBanner: true,
        startsAt: new Date(Date.now() - 3 * hour).toISOString(),
        expiresAt: new Date(Date.now() - hour).toISOString(),
      }).expect(201);
      expect(await activeOffers()).toEqual([]);
    });

    it('shows only one banner when several bundles opt in: the oldest wins', async () => {
      await seedVariant(25000);
      await createBundle({ showAnnouncementBanner: true, bannerText: 'FIRST ONE' }).expect(201);
      await createBundle({ showAnnouncementBanner: true, bannerText: 'SECOND ONE' }).expect(201);
      const offers = await activeOffers();
      expect(offers).toHaveLength(2);
      const banners = offers.map((o) => o.announcementBanner).filter(Boolean);
      expect(banners).toHaveLength(1);
      expect(banners[0]?.text).toBe('FIRST ONE');
    });

    it('does not let a banner-less older bundle block a newer banner', async () => {
      await seedVariant(25000);
      await createBundle({ bannerText: 'NOT SHOWN' }).expect(201);
      await createBundle({ showAnnouncementBanner: true, bannerText: 'SHOWN' }).expect(201);
      const banners = (await activeOffers()).map((o) => o.announcementBanner).filter(Boolean);
      expect(banners).toHaveLength(1);
      expect(banners[0]?.text).toBe('SHOWN');
    });

    it('links a single-collection offer to that collection, but not an inactive one', async () => {
      const collection = await prisma.collection.create({
        data: { slug: `banner-c-${Date.now()}`, nameEn: 'Anime', nameAr: 'انمي' },
      });
      await seedVariant(25000, { collectionId: collection.id });
      await seedVariant(26000, { collectionId: collection.id });
      await createBundle({
        scope: 'COLLECTIONS',
        targetIds: [collection.id],
        showAnnouncementBanner: true,
      }).expect(201);
      let [offer] = await activeOffers();
      expect(offer.announcementBanner?.target).toEqual({
        type: 'COLLECTION',
        href: `/collections/${collection.slug}`,
      });

      await prisma.collection.update({ where: { id: collection.id }, data: { isActive: false } });
      // The offers payload is short-cached; an admin edit invalidates it.
      const [bundle] = await prisma.bundlePromotion.findMany();
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/bundles/${bundle.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ bannerCtaLabel: 'SHOP' })
        .expect(200);
      [offer] = await activeOffers();
      expect(offer.announcementBanner?.target).toEqual({ type: 'CATALOG', href: '/collections' });
    });

    it('exposes no ids or admin fields in the public banner', async () => {
      await seedVariant(25000);
      await createBundle({ showAnnouncementBanner: true }).expect(201);
      const offers = await activeOffers();
      expect(Object.keys(offers[0].announcementBanner as object).sort()).toEqual([
        'ctaLabel',
        'enabled',
        'target',
        'text',
      ]);
      expect(JSON.stringify(offers)).not.toContain('INTERNAL NAME');
    });

    it('rejects over-long banner copy', async () => {
      await createBundle({ showAnnouncementBanner: true, bannerText: 'X'.repeat(81) }).expect(400);
      await createBundle({ showAnnouncementBanner: true, bannerCtaLabel: 'X'.repeat(25) }).expect(
        400,
      );
    });
  });

  describe('bundleProgress on the cart', () => {
    it('is null for an empty cart and when nothing in it is eligible', async () => {
      const { variant } = await seedVariant(25000);
      await createBundle({
        scope: 'SPECIFIC_VARIANTS',
        eligibleVariants: [
          { variantId: variant.id },
          { variantId: (await seedVariant(25000)).variant.id },
        ],
      }).expect(201);
      const empty = await cartWith([]);
      expect(empty.body.bundleProgress).toBeNull();
      const other = await seedVariant(25000); // not in the specific list
      const res = await cartWith([other.variant.id]);
      expect(res.body.bundleProgress).toBeNull();
    });

    it('walks through every state: 1 item, unlocked, multiple groups', async () => {
      const items = [];
      for (let i = 0; i < 5; i += 1) items.push((await seedVariant(25000)).variant.id);
      await createBundle({}).expect(201);

      const one = await cartWith([items[0]]);
      expect(one.body.bundleDiscountTotal).toBe(0);
      expect(one.body.bundleProgress).toMatchObject({
        bundleSize: 2,
        fixedTotal: 45000,
        eligibleUnits: 1,
        groupsApplied: 0,
        unitsNeeded: 1,
        blockedByCoupon: false,
        savingsIfCompleted: 5000,
      });

      const two = await cartWith(items.slice(0, 2));
      expect(two.body.bundleDiscountTotal).toBe(5000);
      expect(two.body.bundleProgress).toMatchObject({ groupsApplied: 1, eligibleUnits: 2 });

      const four = await cartWith(items.slice(0, 4));
      expect(four.body.bundleDiscountTotal).toBe(10000);
      expect(four.body.bundleProgress).toMatchObject({ groupsApplied: 2, eligibleUnits: 4 });

      const five = await cartWith(items);
      expect(five.body.bundleProgress).toMatchObject({ groupsApplied: 2, unitsNeeded: 1 });
    });

    it('reports a coupon that blocks the bundle', async () => {
      const a = (await seedVariant(25000)).variant.id;
      const b = (await seedVariant(25000)).variant.id;
      await createBundle({ allowCouponStacking: false }).expect(201);
      await prisma.coupon.create({
        data: { code: 'TENOFF', type: CouponType.PERCENTAGE, value: 10 },
      });
      const res = await cartWith([a, b], 'TENOFF');
      expect(res.body.bundleDiscountTotal).toBe(0);
      expect(res.body.discountTotal).toBeGreaterThan(0);
      expect(res.body.bundleProgress).toMatchObject({
        blockedByCoupon: true,
        groupsApplied: 0,
        eligibleUnits: 2,
      });
    });

    it('asks for a different phone model when the offer requires one', async () => {
      const brand = await prisma.phoneBrand.create({
        data: { slug: `b-${Date.now()}`, nameEn: 'Brand', nameAr: 'ماركة' },
      });
      const model = await prisma.phoneModel.create({
        data: { slug: `m-${Date.now()}`, nameEn: 'Model', nameAr: 'موديل', brandId: brand.id },
      });
      const other = await prisma.phoneModel.create({
        data: { slug: `m2-${Date.now()}`, nameEn: 'Model 2', nameAr: 'موديل 2', brandId: brand.id },
      });
      const a = (await seedVariant(25000, { modelId: model.id })).variant.id;
      const b = (await seedVariant(25000, { modelId: model.id })).variant.id;
      await seedVariant(25000, { modelId: other.id }); // makes the offer enable-able
      await createBundle({ requireDifferentPhoneModels: true }).expect(201);

      const res = await cartWith([a, b]);
      expect(res.body.bundleDiscountTotal).toBe(0);
      expect(res.body.bundleProgress).toMatchObject({
        requireDifferentPhoneModels: true,
        eligibleUnits: 2,
        groupsApplied: 0,
        unitsNeeded: 1,
      });
    });
  });
});
