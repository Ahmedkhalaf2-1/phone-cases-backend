import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

describe('Coupons admin (e2e)', () => {
  let app: INestApplication;
  let accessToken: string;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
    ({ accessToken } = await createStaffAndLogin(app, StaffRole.CATALOG_MANAGER));
  });

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/coupons')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: `SAVE${++seq}X`, type: 'PERCENTAGE', value: 10, ...body });
  const patch = (id: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .patch(`/api/v1/admin/coupons/${id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);

  it('returns a server-computed status on create, list and get', async () => {
    const active = await post({}).expect(201);
    expect(active.body.status).toBe('ACTIVE');
    const disabled = await post({ isActive: false }).expect(201);
    expect(disabled.body.status).toBe('DISABLED');
    const scheduled = await post({ startsAt: '2099-01-01T00:00:00Z' }).expect(201);
    expect(scheduled.body.status).toBe('SCHEDULED');
    const expired = await post({ expiresAt: '2020-01-01T00:00:00Z' }).expect(201);
    expect(expired.body.status).toBe('EXPIRED');
    const limited = await post({ usageLimit: 5 }).expect(201);
    expect(limited.body.status).toBe('ACTIVE');

    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/coupons')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(list.body).toHaveLength(5);
    expect(list.body.every((c: { status?: string }) => typeof c.status === 'string')).toBe(true);
    const one = await request(app.getHttpServer())
      .get(`/api/v1/admin/coupons/${expired.body.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(one.body.status).toBe('EXPIRED');
  });

  it('updating isActive changes the reported status', async () => {
    const created = await post({}).expect(201);
    const off = await patch(created.body.id, { isActive: false }).expect(200);
    expect(off.body.status).toBe('DISABLED');
    const on = await patch(created.body.id, { isActive: true }).expect(200);
    expect(on.body.status).toBe('ACTIVE');
  });

  it('clears startsAt, expiresAt, minSpend and usageLimit with null', async () => {
    const created = await post({
      startsAt: '2026-11-01T00:00:00Z',
      expiresAt: '2026-12-01T00:00:00Z',
      minSpend: 10000,
      usageLimit: 50,
    }).expect(201);
    const cleared = await patch(created.body.id, {
      startsAt: null,
      expiresAt: null,
      minSpend: null,
      usageLimit: null,
    }).expect(200);
    expect(cleared.body.startsAt).toBeNull();
    expect(cleared.body.expiresAt).toBeNull();
    expect(cleared.body.minSpend).toBeNull();
    expect(cleared.body.usageLimit).toBeNull();
  });

  it('rejects an end date at or before the start date, on create and PATCH', async () => {
    await post({ startsAt: '2026-12-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z' }).expect(400);
    await post({ startsAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z' }).expect(400);
    const created = await post({
      startsAt: '2026-11-01T00:00:00Z',
      expiresAt: '2026-12-01T00:00:00Z',
    }).expect(201);
    await patch(created.body.id, { expiresAt: '2026-10-01T00:00:00Z' }).expect(400);
    await patch(created.body.id, { startsAt: '2027-01-01T00:00:00Z' }).expect(400);
    const renamed = await patch(created.body.id, { isActive: false }).expect(200);
    expect(renamed.body.startsAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('keeps the existing value rules and rejects out-of-range numbers with 400', async () => {
    await post({ type: 'PERCENTAGE', value: 101 }).expect(400);
    await post({ type: 'PERCENTAGE', value: 0 }).expect(400);
    await post({ type: 'FIXED', value: -5 }).expect(400);
    await post({ type: 'FIXED', value: 3_000_000_000 }).expect(400);
    await post({ minSpend: 3_000_000_000 }).expect(400);
    await post({ usageLimit: 0 }).expect(400);
    await post({ usageLimit: 2_000_000 }).expect(400);
    await post({ code: 'a' }).expect(400);
    const created = await post({ type: 'PERCENTAGE', value: 10 }).expect(201);
    await patch(created.body.id, { type: 'FIXED', value: 5000 }).expect(200);
    await patch(created.body.id, { value: 0 }).expect(400);
  });

  it('refuses a duplicate code with 409', async () => {
    await post({ code: 'DUPCODE' }).expect(201);
    await post({ code: 'dupcode' }).expect(409);
  });
});
