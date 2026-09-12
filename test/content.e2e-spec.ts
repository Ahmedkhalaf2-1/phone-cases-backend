import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

describe('Content (e2e)', () => {
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

  describe('homepage sections', () => {
    it('rejects unauthenticated section creation', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/homepage-sections')
        .send({ titleEn: 'Sale' })
        .expect(401);
    });

    it('hides a disabled section from the public endpoint but shows an enabled one', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/homepage-sections')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ titleEn: 'Hidden Banner', titleAr: 'بانر مخفي', isEnabled: false })
        .expect(201);

      const enabled = await request(app.getHttpServer())
        .post('/api/v1/admin/homepage-sections')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          titleEn: 'Live Banner',
          titleAr: 'بانر مفعل',
          linkUrl: '/collections/summer-2026',
          isEnabled: true,
          displayOrder: 1,
        })
        .expect(201);

      const publicList = await request(app.getHttpServer())
        .get('/api/v1/homepage-sections')
        .expect(200);
      expect(publicList.body).toHaveLength(1);
      expect(publicList.body[0].id).toBe(enabled.body.id);
      expect(publicList.body[0].title).toBe('Live Banner');
      expect(publicList.body[0].linkUrl).toBe('/collections/summer-2026');
    });

    it('returns the Arabic title when locale=ar is requested', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/homepage-sections')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ titleEn: 'Live Banner', titleAr: 'بانر مفعل', isEnabled: true })
        .expect(201);

      const arabic = await request(app.getHttpServer())
        .get('/api/v1/homepage-sections?locale=ar')
        .expect(200);
      expect(arabic.body[0].title).toBe('بانر مفعل');
    });

    it('rejects a mediaAssetId that does not point at an existing MediaAsset', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/homepage-sections')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ titleEn: 'Sale', mediaAssetId: '00000000-0000-0000-0000-000000000000' })
        .expect(404);
    });

    it('refuses to delete a MediaAsset still referenced by a homepage section', async () => {
      const staff = await prisma.staffUser.findFirstOrThrow();
      const media = await prisma.mediaAsset.create({
        data: {
          storageKey: 'k1',
          url: 'https://example.test/k1.jpg',
          mimeType: 'image/jpeg',
          fileSizeBytes: 10,
          uploadedByStaffId: staff.id,
        },
      });
      await request(app.getHttpServer())
        .post('/api/v1/admin/homepage-sections')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ titleEn: 'Sale', mediaAssetId: media.id, isEnabled: true })
        .expect(201);

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/media/${media.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(400);
    });

    it('deletes a section', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/admin/homepage-sections')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ titleEn: 'Temp' })
        .expect(201);

      await request(app.getHttpServer())
        .delete(`/api/v1/admin/homepage-sections/${created.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/v1/admin/homepage-sections/${created.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });
  });

  describe('pages', () => {
    it('hides a draft page from public reads', async () => {
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/pages')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          slug: 'about-us',
          titleEn: 'About Us',
          titleAr: 'من نحن',
          bodyEn: '[DEMO CONTENT] Placeholder about page.',
          bodyAr: '[محتوى تجريبي] صفحة تعريفية مؤقتة.',
        })
        .expect(201);
      expect(create.body.status).toBe('DRAFT');

      await request(app.getHttpServer()).get('/api/v1/pages/about-us').expect(404);
      const list = await request(app.getHttpServer()).get('/api/v1/pages').expect(200);
      expect(list.body).toHaveLength(0);
    });

    it('publishes a page and serves it publicly, bilingually', async () => {
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/pages')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          slug: 'shipping-policy',
          titleEn: 'Shipping Policy',
          titleAr: 'سياسة الشحن',
          bodyEn: '[DEMO CONTENT] Placeholder shipping policy.',
          bodyAr: '[محتوى تجريبي] سياسة شحن مؤقتة.',
        })
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/pages/${create.body.id}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PUBLISHED' })
        .expect(200);

      const en = await request(app.getHttpServer())
        .get('/api/v1/pages/shipping-policy')
        .expect(200);
      expect(en.body.title).toBe('Shipping Policy');
      expect(en.body.body).toContain('[DEMO CONTENT]');

      const ar = await request(app.getHttpServer())
        .get('/api/v1/pages/shipping-policy?locale=ar')
        .expect(200);
      expect(ar.body.title).toBe('سياسة الشحن');

      const list = await request(app.getHttpServer()).get('/api/v1/pages').expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].slug).toBe('shipping-policy');
    });

    it('rejects a duplicate slug', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/pages')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          slug: 'faq',
          titleEn: 'FAQ',
          titleAr: 'أسئلة شائعة',
          bodyEn: '[DEMO CONTENT]',
          bodyAr: '[محتوى تجريبي]',
        })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/admin/pages')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          slug: 'faq',
          titleEn: 'FAQ 2',
          titleAr: 'أسئلة شائعة 2',
          bodyEn: '[DEMO CONTENT]',
          bodyAr: '[محتوى تجريبي]',
        })
        .expect(409);
    });

    it('keeps the original publishedAt timestamp across unpublish/republish cycles', async () => {
      const create = await request(app.getHttpServer())
        .post('/api/v1/admin/pages')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          slug: 'returns',
          titleEn: 'Returns',
          titleAr: 'الإرجاع',
          bodyEn: '[DEMO CONTENT]',
          bodyAr: '[محتوى تجريبي]',
        })
        .expect(201);

      const published = await request(app.getHttpServer())
        .patch(`/api/v1/admin/pages/${create.body.id}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'PUBLISHED' })
        .expect(200);
      expect(published.body.publishedAt).not.toBeNull();

      const unpublished = await request(app.getHttpServer())
        .patch(`/api/v1/admin/pages/${create.body.id}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'DRAFT' })
        .expect(200);
      expect(unpublished.body.publishedAt).toBe(published.body.publishedAt);
    });
  });
});
