import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

describe('Inventory (e2e)', () => {
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

  it('never lets onHand go negative under concurrent adjustments', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/v1/admin/stock-items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ sku: 'BLANK-1', nameEn: 'Blank shell', onHand: 5 })
      .expect(201);

    // 8 concurrent requests each try to consume 1 unit against a stock of
    // 5 - a naive read-then-write implementation would oversell here.
    // (Kept modest, not e.g. 50, so this stays reliable on a single shared
    // Postgres connection pool rather than testing the sandbox's own
    // connection-handling limits.)
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app.getHttpServer())
          .patch(`/api/v1/admin/stock-items/${create.body.id}/adjust`)
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ delta: -1, reason: 'concurrent test consumption' }),
      ),
    );

    const succeeded = results.filter((r: { status: number }) => r.status === 200);
    const rejected = results.filter((r: { status: number }) => r.status === 400);

    expect(succeeded).toHaveLength(5);
    expect(rejected).toHaveLength(3);

    const final = await prisma.stockItem.findUniqueOrThrow({ where: { id: create.body.id } });
    expect(final.onHand).toBe(0);
  });

  it('rejects an adjustment that would drive onHand negative', async () => {
    const create = await request(app.getHttpServer())
      .post('/api/v1/admin/stock-items')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ sku: 'BLANK-2', nameEn: 'Blank shell', onHand: 3 })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/stock-items/${create.body.id}/adjust`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ delta: -5, reason: 'too many' })
      .expect(400);

    const unchanged = await prisma.stockItem.findUniqueOrThrow({ where: { id: create.body.id } });
    expect(unchanged.onHand).toBe(3);
  });
});
