import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

describe('Shipping (e2e)', () => {
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

  describe('admin access control', () => {
    it('rejects unauthenticated zone creation', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/shipping-zones')
        .send({ nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] })
        .expect(401);
    });
  });

  describe('zones and rates', () => {
    it('creates a zone and a rate under it', async () => {
      const zone = await request(app.getHttpServer())
        .post('/api/v1/admin/shipping-zones')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ nameEn: 'Egypt', nameAr: 'مصر', countries: ['eg'] })
        .expect(201);
      expect(zone.body.countries).toEqual(['EG']);

      const rate = await request(app.getHttpServer())
        .post(`/api/v1/admin/shipping-zones/${zone.body.id}/rates`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ nameEn: 'Standard', nameAr: 'عادي', price: 5000 })
        .expect(201);
      expect(rate.body.price).toBe(5000);
    });

    it('rejects a rate for a non-existent zone', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/admin/shipping-zones/00000000-0000-0000-0000-000000000000/rates')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ nameEn: 'Standard', nameAr: 'عادي', price: 5000 })
        .expect(404);
    });
  });

  describe('public shipping options', () => {
    it('lists active rates for a covered country', async () => {
      const zone = await prisma.shippingZone.create({
        data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
      });
      await prisma.shippingRate.create({
        data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price: 5000 },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/shipping-options?country=EG')
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].price).toBe(5000);
    });

    it('returns an empty list for an uncovered country', async () => {
      const zone = await prisma.shippingZone.create({
        data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] },
      });
      await prisma.shippingRate.create({
        data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price: 5000 },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/shipping-options?country=US')
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('excludes rates from an inactive zone', async () => {
      const zone = await prisma.shippingZone.create({
        data: { nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'], isActive: false },
      });
      await prisma.shippingRate.create({
        data: { zoneId: zone.id, nameEn: 'Standard', nameAr: 'عادي', price: 5000 },
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/shipping-options?country=EG')
        .expect(200);
      expect(res.body).toEqual([]);
    });
  });
  describe('admin input validation', () => {
    async function seedZone() {
      const zone = await request(app.getHttpServer())
        .post('/api/v1/admin/shipping-zones')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ nameEn: 'Egypt', nameAr: 'مصر', countries: ['EG'] })
        .expect(201);
      return zone.body.id as string;
    }
    const auth = () => ({ Authorization: `Bearer ${accessToken}` });
    const rateBody = { nameEn: 'Standard', nameAr: 'عادي', price: 5000 };

    it('rejects an inverted delivery range on create', async () => {
      const zoneId = await seedZone();
      await request(app.getHttpServer())
        .post(`/api/v1/admin/shipping-zones/${zoneId}/rates`)
        .set(auth())
        .send({ ...rateBody, estimatedDaysMin: 5, estimatedDaysMax: 2 })
        .expect(400);
      await request(app.getHttpServer())
        .post(`/api/v1/admin/shipping-zones/${zoneId}/rates`)
        .set(auth())
        .send({ ...rateBody, estimatedDaysMin: 2, estimatedDaysMax: 2 })
        .expect(201);
    });

    it('validates a PATCH against the stored range, and can clear optional fields with null', async () => {
      const zoneId = await seedZone();
      const created = await request(app.getHttpServer())
        .post(`/api/v1/admin/shipping-zones/${zoneId}/rates`)
        .set(auth())
        .send({
          ...rateBody,
          freeShippingThreshold: 150000,
          estimatedDaysMin: 2,
          estimatedDaysMax: 5,
        })
        .expect(201);
      const url = `/api/v1/admin/shipping-zones/${zoneId}/rates/${created.body.id}`;
      await request(app.getHttpServer())
        .patch(url)
        .set(auth())
        .send({ estimatedDaysMin: 9 })
        .expect(400);
      await request(app.getHttpServer())
        .patch(url)
        .set(auth())
        .send({ estimatedDaysMax: 1 })
        .expect(400);
      const renamed = await request(app.getHttpServer())
        .patch(url)
        .set(auth())
        .send({ nameEn: 'Renamed' })
        .expect(200);
      expect(renamed.body.estimatedDaysMin).toBe(2);
      const cleared = await request(app.getHttpServer())
        .patch(url)
        .set(auth())
        .send({ freeShippingThreshold: null, estimatedDaysMin: null, estimatedDaysMax: null })
        .expect(200);
      expect(cleared.body.freeShippingThreshold).toBeNull();
      expect(cleared.body.estimatedDaysMin).toBeNull();
      expect(cleared.body.estimatedDaysMax).toBeNull();
    });

    it('returns 400, not 500, for out-of-range numbers and nulled required fields', async () => {
      const zoneId = await seedZone();
      const ratesUrl = `/api/v1/admin/shipping-zones/${zoneId}/rates`;
      await request(app.getHttpServer())
        .post(ratesUrl)
        .set(auth())
        .send({ ...rateBody, price: 3_000_000_000 })
        .expect(400);
      await request(app.getHttpServer())
        .post(ratesUrl)
        .set(auth())
        .send({ ...rateBody, freeShippingThreshold: 3_000_000_000 })
        .expect(400);
      await request(app.getHttpServer())
        .post(ratesUrl)
        .set(auth())
        .send({ ...rateBody, estimatedDaysMax: 100000 })
        .expect(400);
      await request(app.getHttpServer())
        .post(ratesUrl)
        .set(auth())
        .send({ ...rateBody, displayOrder: 3_000_000_000 })
        .expect(400);
      await request(app.getHttpServer())
        .post(ratesUrl)
        .set(auth())
        .send({ ...rateBody, nameEn: '   ' })
        .expect(400);
      const created = await request(app.getHttpServer())
        .post(ratesUrl)
        .set(auth())
        .send(rateBody)
        .expect(201);
      const url = `${ratesUrl}/${created.body.id}`;
      await request(app.getHttpServer()).patch(url).set(auth()).send({ nameEn: null }).expect(400);
      await request(app.getHttpServer()).patch(url).set(auth()).send({ price: null }).expect(400);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/shipping-zones/${zoneId}`)
        .set(auth())
        .send({ nameEn: null })
        .expect(400);
    });

    it('normalizes and de-duplicates zone countries', async () => {
      const zone = await request(app.getHttpServer())
        .post('/api/v1/admin/shipping-zones')
        .set(auth())
        .send({ nameEn: 'Gulf', nameAr: 'الخليج', countries: ['sa', 'SA', 'ae'] })
        .expect(201);
      expect(zone.body.countries).toEqual(['SA', 'AE']);
    });
  });
});
