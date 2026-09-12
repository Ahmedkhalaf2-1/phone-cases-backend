import { INestApplication } from '@nestjs/common';
import { CouponType } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, resetDatabase } from './utils/test-app';

describe('Cart (e2e)', () => {
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

  async function seedPublishedVariant(price = 10000) {
    const product = await prisma.product.create({
      data: { slug: 'space', nameEn: 'Space', nameAr: 'الفضاء', status: 'PUBLISHED' },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, sku: 'SPACE-1', price },
    });
    return { product, variant };
  }

  async function createCart(): Promise<{ token: string }> {
    const res = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
    return { token: res.body.token as string };
  }

  describe('access control', () => {
    it('rejects cart access with no token', async () => {
      await request(app.getHttpServer()).get('/api/v1/cart').expect(401);
    });

    it('rejects cart access with an unknown token', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('X-Cart-Token', 'not-a-real-token')
        .expect(401);
    });

    it('allows access with the token returned at creation', async () => {
      const { token } = await createCart();
      const res = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('X-Cart-Token', token)
        .expect(200);
      expect(res.body.items).toEqual([]);
    });
  });

  describe('items', () => {
    it('adds an item and computes the line and cart totals', async () => {
      const { variant } = await seedPublishedVariant(10000);
      const { token } = await createCart();

      const res = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 3 })
        .expect(201);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].lineSubtotal).toBe(30000);
      expect(res.body.subtotal).toBe(30000);
      expect(res.body.total).toBe(30000);
    });

    it('merges quantities when the same variant is added twice', async () => {
      const { variant } = await seedPublishedVariant(1000);
      const { token } = await createCart();

      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 2 })
        .expect(201);
      const res = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 3 })
        .expect(201);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].quantity).toBe(5);
    });

    it('rejects adding a variant of an unpublished product', async () => {
      const product = await prisma.product.create({
        data: { slug: 'draft-product', nameEn: 'Draft', nameAr: 'مسودة', status: 'DRAFT' },
      });
      const variant = await prisma.productVariant.create({
        data: { productId: product.id, sku: 'DRAFT-1', price: 1000 },
      });
      const { token } = await createCart();

      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(409);
    });

    it('rejects adding more than the currently available stock', async () => {
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-1', nameEn: 'Blank', onHand: 3 },
      });
      const { variant } = await seedPublishedVariant(1000);
      await prisma.productVariant.update({
        where: { id: variant.id },
        data: { stockItemId: stockItem.id },
      });
      const { token } = await createCart();

      const res = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 4 })
        .expect(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
    });

    it('updates an item quantity, and quantity 0 removes it', async () => {
      const { variant } = await seedPublishedVariant(1000);
      const { token } = await createCart();
      const added = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 2 })
        .expect(201);
      const itemId = added.body.items[0].id;

      const updated = await request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${itemId}`)
        .set('X-Cart-Token', token)
        .send({ quantity: 5 })
        .expect(200);
      expect(updated.body.items[0].quantity).toBe(5);

      const removed = await request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${itemId}`)
        .set('X-Cart-Token', token)
        .send({ quantity: 0 })
        .expect(200);
      expect(removed.body.items).toHaveLength(0);
    });

    it('removes an item via DELETE', async () => {
      const { variant } = await seedPublishedVariant(1000);
      const { token } = await createCart();
      const added = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);
      const itemId = added.body.items[0].id;

      const res = await request(app.getHttpServer())
        .delete(`/api/v1/cart/items/${itemId}`)
        .set('X-Cart-Token', token)
        .expect(200);
      expect(res.body.items).toHaveLength(0);
    });
  });

  describe('coupons', () => {
    it('applies a percentage coupon and computes the discount', async () => {
      const { variant } = await seedPublishedVariant(10000);
      const { token } = await createCart();
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);

      await prisma.coupon.create({
        data: { code: 'SAVE10', type: CouponType.PERCENTAGE, value: 10 },
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/cart/coupon')
        .set('X-Cart-Token', token)
        .send({ code: 'save10' })
        .expect(201);

      expect(res.body.discountTotal).toBe(1000);
      expect(res.body.total).toBe(9000);
    });

    it('rejects a coupon below its minimum spend', async () => {
      const { variant } = await seedPublishedVariant(1000);
      const { token } = await createCart();
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);

      await prisma.coupon.create({
        data: { code: 'BIGSPEND', type: CouponType.FIXED, value: 500, minSpend: 5000 },
      });

      await request(app.getHttpServer())
        .post('/api/v1/cart/coupon')
        .set('X-Cart-Token', token)
        .send({ code: 'BIGSPEND' })
        .expect(400);
    });

    it('rejects an expired coupon', async () => {
      const { variant } = await seedPublishedVariant(1000);
      const { token } = await createCart();
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);

      await prisma.coupon.create({
        data: {
          code: 'EXPIRED',
          type: CouponType.FIXED,
          value: 100,
          expiresAt: new Date('2020-01-01'),
        },
      });

      await request(app.getHttpServer())
        .post('/api/v1/cart/coupon')
        .set('X-Cart-Token', token)
        .send({ code: 'EXPIRED' })
        .expect(400);
    });

    it('removes a previously applied coupon', async () => {
      const { variant } = await seedPublishedVariant(10000);
      const { token } = await createCart();
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);
      await prisma.coupon.create({
        data: { code: 'FLAT500', type: CouponType.FIXED, value: 500 },
      });
      await request(app.getHttpServer())
        .post('/api/v1/cart/coupon')
        .set('X-Cart-Token', token)
        .send({ code: 'FLAT500' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .delete('/api/v1/cart/coupon')
        .set('X-Cart-Token', token)
        .expect(200);

      expect(res.body.coupon).toBeNull();
      expect(res.body.discountTotal).toBe(0);
    });
  });

  describe('atomic variant replacement', () => {
    it('replaces a line item variant, keeping the same quantity', async () => {
      const { product, variant: firstVariant } = await seedPublishedVariant(1000);
      const otherVariant = await prisma.productVariant.create({
        data: { productId: product.id, sku: 'SPACE-2', price: 2000 },
      });
      const { token } = await createCart();
      const added = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: firstVariant.id, quantity: 2 })
        .expect(201);
      const itemId = added.body.items[0].id;

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${itemId}/variant`)
        .set('X-Cart-Token', token)
        .send({ newVariantId: otherVariant.id })
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].variantId).toBe(otherVariant.id);
      expect(res.body.items[0].quantity).toBe(2);
    });

    it('merges into an existing line when replacing into an already-present variant', async () => {
      const { product, variant: variantA } = await seedPublishedVariant(1000);
      const variantB = await prisma.productVariant.create({
        data: { productId: product.id, sku: 'SPACE-B', price: 1000 },
      });
      const { token } = await createCart();
      const addedA = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variantA.id, quantity: 2 })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variantB.id, quantity: 3 })
        .expect(201);
      const itemAId = addedA.body.items[0].id;

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${itemAId}/variant`)
        .set('X-Cart-Token', token)
        .send({ newVariantId: variantB.id })
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].variantId).toBe(variantB.id);
      expect(res.body.items[0].quantity).toBe(5);
    });

    it('preserves the original item when replacement targets an unpublished variant', async () => {
      const { variant: originalVariant } = await seedPublishedVariant(1000);
      const draftProduct = await prisma.product.create({
        data: { slug: 'draft-target', nameEn: 'Draft', nameAr: 'مسودة', status: 'DRAFT' },
      });
      const unpublishedVariant = await prisma.productVariant.create({
        data: { productId: draftProduct.id, sku: 'DRAFT-TARGET-1', price: 1000 },
      });
      const { token } = await createCart();
      const added = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: originalVariant.id, quantity: 2 })
        .expect(201);
      const itemId = added.body.items[0].id;

      await request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${itemId}/variant`)
        .set('X-Cart-Token', token)
        .send({ newVariantId: unpublishedVariant.id })
        .expect(409);

      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('X-Cart-Token', token)
        .expect(200);
      expect(cart.body.items).toHaveLength(1);
      expect(cart.body.items[0].variantId).toBe(originalVariant.id);
      expect(cart.body.items[0].quantity).toBe(2);
    });

    it('preserves the original item when the resulting quantity exceeds available stock', async () => {
      const { variant: originalVariant } = await seedPublishedVariant(1000);
      const stockItem = await prisma.stockItem.create({
        data: { sku: 'BLANK-REPLACE', nameEn: 'Blank', onHand: 1 },
      });
      const limitedProduct = await prisma.product.create({
        data: { slug: 'limited-target', nameEn: 'Limited', nameAr: 'محدود', status: 'PUBLISHED' },
      });
      const limitedVariant = await prisma.productVariant.create({
        data: {
          productId: limitedProduct.id,
          sku: 'LIMITED-TARGET-1',
          price: 1000,
          stockItemId: stockItem.id,
        },
      });
      const { token } = await createCart();
      const added = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: originalVariant.id, quantity: 3 })
        .expect(201);
      const itemId = added.body.items[0].id;

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/cart/items/${itemId}/variant`)
        .set('X-Cart-Token', token)
        .send({ newVariantId: limitedVariant.id })
        .expect(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');

      const cart = await request(app.getHttpServer())
        .get('/api/v1/cart')
        .set('X-Cart-Token', token)
        .expect(200);
      expect(cart.body.items).toHaveLength(1);
      expect(cart.body.items[0].variantId).toBe(originalVariant.id);
      expect(cart.body.items[0].quantity).toBe(3);
    });
  });

  describe('cart-not-active enforcement', () => {
    it('rejects mutating an already-ordered cart but still allows reading it', async () => {
      const { token } = await createCart();
      const cart = await prisma.cart.findUniqueOrThrow({ where: { token } });
      await prisma.cart.update({ where: { id: cart.id }, data: { status: 'ORDERED' } });

      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: (await seedPublishedVariant(1000)).variant.id, quantity: 1 })
        .expect(409);

      await request(app.getHttpServer()).get('/api/v1/cart').set('X-Cart-Token', token).expect(200);
    });
  });
});
