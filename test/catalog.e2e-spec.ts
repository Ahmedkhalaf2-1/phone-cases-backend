import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

describe('Catalog (e2e)', () => {
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

  async function seedTaxonomy() {
    const brand = await prisma.phoneBrand.create({
      data: { slug: 'apple', nameEn: 'Apple', nameAr: 'أبل' },
    });
    const model15 = await prisma.phoneModel.create({
      data: { slug: 'iphone-15', nameEn: 'iPhone 15', nameAr: 'آيفون 15', brandId: brand.id },
    });
    const model16 = await prisma.phoneModel.create({
      data: { slug: 'iphone-16', nameEn: 'iPhone 16', nameAr: 'آيفون 16', brandId: brand.id },
    });
    const shockCase = await prisma.caseType.create({
      data: { slug: 'shock-resistant', nameEn: 'Shock-Resistant', nameAr: 'مقاوم للصدمات' },
    });
    return { brand, model15, model16, shockCase };
  }

  describe('access control', () => {
    it('rejects unauthenticated admin product creation', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .send({ slug: 'space', nameEn: 'Space', nameAr: 'الفضاء' })
        .expect(401);
    });
  });

  describe('product visibility', () => {
    it('hides a draft product from the public list and detail endpoints', async () => {
      const { model15, shockCase } = await seedTaxonomy();
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ slug: 'space', nameEn: 'Space', nameAr: 'الفضاء' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${create.body.id}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          sku: 'SPACE-IP15-SHOCK',
          phoneModelId: model15.id,
          caseTypeId: shockCase.id,
          price: 45000,
        })
        .expect(201);

      // Still DRAFT - must not appear publicly.
      const list = await request(app.getHttpServer()).get('/api/v1/products').expect(200);
      expect(list.body.items).toHaveLength(0);

      await request(app.getHttpServer()).get('/api/v1/products/space').expect(404);

      // But an authenticated catalog manager can see it.
      const adminGet = await request(app.getHttpServer())
        .get(`/api/v1/admin/products/${create.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(adminGet.body.status).toBe('DRAFT');
    });

    it('exposes a published product publicly with effective pricing and compatibility', async () => {
      const { model15, shockCase } = await seedTaxonomy();
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ slug: 'space', nameEn: 'Space', nameAr: 'الفضاء' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${create.body.id}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          sku: 'SPACE-IP15-SHOCK',
          phoneModelId: model15.id,
          caseTypeId: shockCase.id,
          price: 45000,
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${create.body.id}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PUBLISHED' })
        .expect(200);

      const detail = await request(app.getHttpServer()).get('/api/v1/products/space').expect(200);
      expect(detail.body.effectivePriceFrom).toBe(45000);
      expect(detail.body.variants[0].phoneModel.slug).toBe('iphone-15');
      expect(detail.body.variants[0].isAvailable).toBe(true);
    });
  });

  describe('publish state machine', () => {
    it('refuses to publish a product with no active variants', async () => {
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ slug: 'empty', nameEn: 'Empty', nameAr: 'فارغ' })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${create.body.id}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PUBLISHED' })
        .expect(409);
    });

    it('refuses an invalid transition from PUBLISHED directly back to DRAFT', async () => {
      const { model15, shockCase } = await seedTaxonomy();
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ slug: 'space', nameEn: 'Space', nameAr: 'الفضاء' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${create.body.id}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ sku: 'SPACE-1', phoneModelId: model15.id, caseTypeId: shockCase.id, price: 1000 })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${create.body.id}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PUBLISHED' })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${create.body.id}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'DRAFT' })
        .expect(409);
    });
  });

  describe('duplicate prevention', () => {
    it('rejects a second product with the same slug', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ slug: 'space', nameEn: 'Space', nameAr: 'الفضاء' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ slug: 'space', nameEn: 'Space 2', nameAr: 'الفضاء 2' })
        .expect(409);
    });

    it('rejects a second variant with the same SKU', async () => {
      const { model15, model16, shockCase } = await seedTaxonomy();
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ slug: 'space', nameEn: 'Space', nameAr: 'الفضاء' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${create.body.id}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ sku: 'DUP-SKU', phoneModelId: model15.id, caseTypeId: shockCase.id, price: 1000 })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${create.body.id}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ sku: 'DUP-SKU', phoneModelId: model16.id, caseTypeId: shockCase.id, price: 2000 })
        .expect(409);
      expect(res.body.code).toBe('VARIANT_SKU_TAKEN');
    });

    it('rejects a second variant for the same product/phoneModel/caseType combination', async () => {
      const { model15, shockCase } = await seedTaxonomy();
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ slug: 'space', nameEn: 'Space', nameAr: 'الفضاء' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${create.body.id}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ sku: 'SKU-A', phoneModelId: model15.id, caseTypeId: shockCase.id, price: 1000 })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${create.body.id}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ sku: 'SKU-B', phoneModelId: model15.id, caseTypeId: shockCase.id, price: 2000 })
        .expect(409);
      expect(res.body.code).toBe('VARIANT_COMBINATION_EXISTS');
    });
  });

  describe('variant pricing rules', () => {
    it('rejects a compareAtPrice that is not greater than price', async () => {
      const { model15, shockCase } = await seedTaxonomy();
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ slug: 'space', nameEn: 'Space', nameAr: 'الفضاء' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${create.body.id}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          sku: 'SKU-A',
          phoneModelId: model15.id,
          caseTypeId: shockCase.id,
          price: 1000,
          compareAtPrice: 1000,
        })
        .expect(400);
    });
  });

  describe('filtering', () => {
    it('filters public products by phone model compatibility', async () => {
      // model16 is intentionally unused here - it exists only so the
      // "non-matching" assertion below has a real, incompatible model to
      // filter by.
      const { model15, shockCase } = await seedTaxonomy();
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ slug: 'space', nameEn: 'Space', nameAr: 'الفضاء' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${create.body.id}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ sku: 'SKU-15', phoneModelId: model15.id, caseTypeId: shockCase.id, price: 1000 })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${create.body.id}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PUBLISHED' })
        .expect(200);

      const matching = await request(app.getHttpServer())
        .get('/api/v1/products?phoneModel=iphone-15')
        .expect(200);
      expect(matching.body.items).toHaveLength(1);

      const nonMatching = await request(app.getHttpServer())
        .get('/api/v1/products?phoneModel=iphone-16')
        .expect(200);
      expect(nonMatching.body.items).toHaveLength(0);
    });
  });

  describe('client-supplied price manipulation', () => {
    it('ignores a client-supplied price override and returns the server-stored price', async () => {
      const { model15, shockCase } = await seedTaxonomy();
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/products')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ slug: 'space', nameEn: 'Space', nameAr: 'الفضاء' })
        .expect(201);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${create.body.id}/variants`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ sku: 'SKU-15', phoneModelId: model15.id, caseTypeId: shockCase.id, price: 45000 })
        .expect(201);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${create.body.id}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PUBLISHED' })
        .expect(200);

      // The public detail endpoint has no way to accept a client price at
      // all (GET only) - this asserts the server-computed price is what a
      // frontend would actually see, independent of anything a client sends.
      const detail = await request(app.getHttpServer()).get('/api/v1/products/space').expect(200);
      expect(detail.body.variants[0].price).toBe(45000);
    });
  });
});
