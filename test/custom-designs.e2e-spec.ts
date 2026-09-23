import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import sharp from 'sharp';
import { PrismaService } from '../src/prisma/prisma.service';
import { DEFAULT_PRINT_SPEC } from '../src/modules/custom-designs/print-spec.util';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

jest.setTimeout(30_000);

describe('Custom designs (e2e)', () => {
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

  async function image(width: number, height: number, hex = '#3366ff'): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: hex } })
      .jpeg()
      .toBuffer();
  }

  // A small override keeps most tests' fixture images tiny/fast - only the
  // "uses the built-in default when no override exists" test needs a real
  // DEFAULT_PRINT_SPEC-sized image.
  async function seedPersonalizableVariant(
    opts: { customizationPrice?: number; printSpec?: { widthPx: number; heightPx: number } } = {},
  ) {
    const product = await prisma.product.create({
      data: {
        slug: `custom-${Date.now()}-${Math.random()}`,
        nameEn: 'Custom Case',
        nameAr: 'كفر مخصص',
        status: 'PUBLISHED',
      },
    });
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `CUSTOM-${Date.now()}-${Math.random()}`,
        price: 10000,
        isUnlimitedStock: true,
        isPersonalizable: true,
        customizationPrice: opts.customizationPrice ?? 1500,
      },
    });
    if (opts.printSpec) {
      await prisma.printSpecification.create({
        data: {
          variantId: variant.id,
          widthPx: opts.printSpec.widthPx,
          heightPx: opts.printSpec.heightPx,
        },
      });
    }
    return { product, variant };
  }

  async function seedNonPersonalizableVariant() {
    const product = await prisma.product.create({
      data: {
        slug: `plain-${Date.now()}-${Math.random()}`,
        nameEn: 'Plain Case',
        nameAr: 'كفر عادي',
        status: 'PUBLISHED',
      },
    });
    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        sku: `PLAIN-${Date.now()}-${Math.random()}`,
        price: 5000,
        isUnlimitedStock: true,
      },
    });
    return { product, variant };
  }

  async function createCart(): Promise<string> {
    const res = await request(app.getHttpServer()).post('/api/v1/cart').expect(201);
    return res.body.token as string;
  }

  // Deliberately NOT `async` - returning a supertest `Test` (itself a
  // thenable) from an `async function` would unwrap it to its resolved
  // `Response` before the caller ever sees it, losing the chainable
  // `.expect(...)` callers rely on below.
  function uploadDesign(token: string, variantId: string, buffer: Buffer, filename = 'design.jpg') {
    return request(app.getHttpServer())
      .post('/api/v1/cart/custom-designs')
      .set('X-Cart-Token', token)
      .field('variantId', variantId)
      .attach('file', buffer, filename);
  }

  const SMALL_SPEC = { widthPx: 200, heightPx: 400 };

  describe('upload validation', () => {
    it('rejects an unknown variant', async () => {
      const token = await createCart();
      const buffer = await image(200, 400);
      await uploadDesign(token, '00000000-0000-0000-0000-000000000000', buffer).expect(404);
    });

    it('rejects a variant that is not personalizable', async () => {
      const token = await createCart();
      const { variant } = await seedNonPersonalizableVariant();
      const buffer = await image(200, 400);
      await uploadDesign(token, variant.id, buffer).expect(409);
    });

    it('rejects a request with no file', async () => {
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      await request(app.getHttpServer())
        .post('/api/v1/cart/custom-designs')
        .set('X-Cart-Token', token)
        .field('variantId', variant.id)
        .expect(400);
    });

    it('rejects an unsupported file type', async () => {
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      await uploadDesign(token, variant.id, Buffer.from('not an image'), 'file.txt').expect(400);
    });

    it('rejects a corrupt image with an allowed extension/mimetype', async () => {
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      await uploadDesign(token, variant.id, Buffer.from('corrupt'), 'design.jpg').expect(400);
    });

    it('rejects an image below the required print resolution, with the requirement in the error', async () => {
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      const buffer = await image(199, 400);
      const res = await uploadDesign(token, variant.id, buffer).expect(400);
      expect(res.body.message).toContain('200x400');
    });

    it('accepts a valid image at exactly the required resolution and renders center-crop+cover automatically', async () => {
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      // Wider-than-tall source against a portrait target - proves the
      // print file is actually cropped to the target, not just resized.
      const buffer = await image(800, 400);
      const res = await uploadDesign(token, variant.id, buffer).expect(201);

      expect(res.body.fitMode).toBe('CENTER_CROP_COVER');
      expect(res.body.print.widthPx).toBe(SMALL_SPEC.widthPx);
      expect(res.body.print.heightPx).toBe(SMALL_SPEC.heightPx);
      expect(res.body.original.width).toBe(800);
      expect(res.body.original.height).toBe(400);
      expect(res.body.storageKey).toBeUndefined();
    });

    it('uses the built-in default print spec when the variant has no override', async () => {
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant();
      const buffer = await image(DEFAULT_PRINT_SPEC.widthPx, DEFAULT_PRINT_SPEC.heightPx);
      const res = await uploadDesign(token, variant.id, buffer).expect(201);
      expect(res.body.print.widthPx).toBe(DEFAULT_PRINT_SPEC.widthPx);
      expect(res.body.print.heightPx).toBe(DEFAULT_PRINT_SPEC.heightPx);
    });
  });

  describe('file retrieval', () => {
    it('serves the preview and original to the owning cart, but not to a different cart', async () => {
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      const buffer = await image(200, 400);
      const uploaded = await uploadDesign(token, variant.id, buffer).expect(201);
      const designId = uploaded.body.id as string;

      const preview = await request(app.getHttpServer())
        .get(`/api/v1/cart/custom-designs/${designId}/preview`)
        .set('X-Cart-Token', token)
        .expect(200);
      expect(preview.headers['content-type']).toContain('image/jpeg');

      await request(app.getHttpServer())
        .get(`/api/v1/cart/custom-designs/${designId}/original`)
        .set('X-Cart-Token', token)
        .expect(200);

      const otherToken = await createCart();
      await request(app.getHttpServer())
        .get(`/api/v1/cart/custom-designs/${designId}/preview`)
        .set('X-Cart-Token', otherToken)
        .expect(404);
    });
  });

  describe('cart attach/replace/remove', () => {
    it('lets a personalized line exist without a design, marking the cart unavailable until one is attached', async () => {
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });

      const added = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);
      expect(added.body.items[0].isAvailable).toBe(false);
      expect(added.body.items[0].isPersonalized).toBe(true);
      const itemId = added.body.items[0].id as string;

      const buffer = await image(200, 400);
      const uploaded = await uploadDesign(token, variant.id, buffer).expect(201);

      const attached = await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${itemId}/custom-design`)
        .set('X-Cart-Token', token)
        .send({ customDesignId: uploaded.body.id })
        .expect(200);
      expect(attached.body.items[0].isAvailable).toBe(true);
      expect(attached.body.items[0].unitPrice).toBe(10000 + 1500);
      expect(attached.body.items[0].customDesign.id).toBe(uploaded.body.id);

      const removed = await request(app.getHttpServer())
        .delete(`/api/v1/cart/items/${itemId}/custom-design`)
        .set('X-Cart-Token', token)
        .expect(200);
      expect(removed.body.items[0].isAvailable).toBe(false);
      expect(removed.body.items[0].customDesign).toBeNull();
    });

    it('creates a distinct cart line per personalized add instead of merging', async () => {
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });

      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);
      const second = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);

      expect(second.body.items).toHaveLength(2);
    });

    it('attaches a design directly on add when customDesignId is provided', async () => {
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      const buffer = await image(200, 400);
      const uploaded = await uploadDesign(token, variant.id, buffer).expect(201);

      const added = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 2, customDesignId: uploaded.body.id })
        .expect(201);

      expect(added.body.items[0].isAvailable).toBe(true);
      expect(added.body.items[0].lineSubtotal).toBe((10000 + 1500) * 2);
    });

    it('rejects customDesignId for a non-personalizable variant', async () => {
      const token = await createCart();
      const { variant: personalizable } = await seedPersonalizableVariant({
        printSpec: SMALL_SPEC,
      });
      const { variant: plain } = await seedNonPersonalizableVariant();
      const buffer = await image(200, 400);
      const uploaded = await uploadDesign(token, personalizable.id, buffer).expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: plain.id, quantity: 1, customDesignId: uploaded.body.id })
        .expect(400);
    });

    it('rejects attaching a design uploaded for a different variant', async () => {
      const token = await createCart();
      const { variant: variantA } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      const { variant: variantB } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      const buffer = await image(200, 400);
      const designForB = await uploadDesign(token, variantB.id, buffer).expect(201);

      const item = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variantA.id, quantity: 1 })
        .expect(201);
      const itemId = item.body.items[0].id as string;

      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${itemId}/custom-design`)
        .set('X-Cart-Token', token)
        .send({ customDesignId: designForB.body.id })
        .expect(409);
    });

    it('rejects attaching a design owned by a different cart', async () => {
      const ownerToken = await createCart();
      const attackerToken = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      const buffer = await image(200, 400);
      const design = await uploadDesign(ownerToken, variant.id, buffer).expect(201);

      const item = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', attackerToken)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);
      const itemId = item.body.items[0].id as string;

      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${itemId}/custom-design`)
        .set('X-Cart-Token', attackerToken)
        .send({ customDesignId: design.body.id })
        .expect(404);
    });

    it('rejects attaching a design that is already attached to a different cart item', async () => {
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      const buffer = await image(200, 400);
      const design = await uploadDesign(token, variant.id, buffer).expect(201);

      const item1 = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1, customDesignId: design.body.id })
        .expect(201);
      const item2 = await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);
      const item2Id = item2.body.items.find((i: { id: string }) => i.id !== item1.body.items[0].id)
        .id as string;

      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${item2Id}/custom-design`)
        .set('X-Cart-Token', token)
        .send({ customDesignId: design.body.id })
        .expect(409);
    });
  });

  describe('checkout', () => {
    async function seedEgyptShipping(price = 5000) {
      const zone = await prisma.shippingZone.create({
        data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
      });
      return prisma.shippingRate.create({
        data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price },
      });
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

    it('blocks checkout while a personalized line has no design attached', async () => {
      const rate = await seedEgyptShipping();
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({ printSpec: SMALL_SPEC });
      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 1 })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: 0 }))
        .expect(409);
    });

    it('snapshots the design and customization price into the order, visible to admin with working download routes', async () => {
      const rate = await seedEgyptShipping(5000);
      const token = await createCart();
      const { variant } = await seedPersonalizableVariant({
        customizationPrice: 1500,
        printSpec: SMALL_SPEC,
      });
      const buffer = await image(200, 400);
      const design = await uploadDesign(token, variant.id, buffer).expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/cart/items')
        .set('X-Cart-Token', token)
        .send({ variantId: variant.id, quantity: 2, customDesignId: design.body.id })
        .expect(201);

      const quote = await request(app.getHttpServer())
        .post('/api/v1/checkout/quote')
        .set('X-Cart-Token', token)
        .send({ country: 'EG', shippingRateId: rate.id })
        .expect(201);
      expect(quote.body.subtotal).toBe((10000 + 1500) * 2);

      const order = await request(app.getHttpServer())
        .post('/api/v1/orders')
        .set('X-Cart-Token', token)
        .send(orderBody({ shippingRateId: rate.id, expectedTotal: quote.body.total }))
        .expect(201);

      expect(order.body.items[0].unitPrice).toBe(10000 + 1500);
      expect(order.body.items[0].quantity).toBe(2);

      // Removing the cart's design after checkout must never affect the
      // already-placed order's own copy.
      const orderRow = await prisma.order.findFirstOrThrow({
        include: { items: { include: { customDesign: true } } },
      });
      const orderItem = orderRow.items[0];
      expect(orderItem.customizationPrice).toBe(1500);
      expect(orderItem.customDesign).not.toBeNull();
      expect(orderItem.customDesign?.printWidthPx).toBe(SMALL_SPEC.widthPx);
      expect(orderItem.customDesign?.printHeightPx).toBe(SMALL_SPEC.heightPx);
      expect(orderItem.customDesign?.sourceCustomDesignId).toBe(design.body.id);

      await prisma.customDesign.delete({ where: { id: design.body.id } });
      const stillThere = await prisma.orderItemCustomDesign.findUnique({
        where: { orderItemId: orderItem.id },
      });
      expect(stillThere).not.toBeNull();
      expect(stillThere?.sourceCustomDesignId).toBeNull();

      // Admin access controls: role-gated, keyed by orderItemId, three kinds.
      const owner = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);
      const catalogManager = await createStaffAndLogin(app, StaffRole.CATALOG_MANAGER, {
        email: 'catalog-manager@test.local',
      });

      await request(app.getHttpServer())
        .get(`/api/v1/admin/order-items/${orderItem.id}/custom-design/original`)
        .expect(401);

      await request(app.getHttpServer())
        .get(`/api/v1/admin/order-items/${orderItem.id}/custom-design/original`)
        .set('Authorization', `Bearer ${catalogManager.accessToken}`)
        .expect(403);

      const original = await request(app.getHttpServer())
        .get(`/api/v1/admin/order-items/${orderItem.id}/custom-design/original`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(original.headers['content-type']).toContain('image/jpeg');

      const printFile = await request(app.getHttpServer())
        .get(`/api/v1/admin/order-items/${orderItem.id}/custom-design/print-file`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(printFile.headers['content-disposition']).toContain('attachment');

      await request(app.getHttpServer())
        .get(`/api/v1/admin/order-items/${orderItem.id}/custom-design/preview`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
    });
  });
});
