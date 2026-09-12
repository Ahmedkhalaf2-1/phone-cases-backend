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
});
