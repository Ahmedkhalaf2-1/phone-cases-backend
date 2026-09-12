import { INestApplication } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import { createStaffAndLogin, createTestApp, resetDatabase } from './utils/test-app';

describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(app);
  });

  it('rejects login with wrong password', async () => {
    await createStaffAndLogin(app, StaffRole.OWNER_ADMIN, {
      email: 'owner@test.local',
      password: 'correct-password',
    });

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'owner@test.local', password: 'wrong-password' })
      .expect(401);
  });

  it('rejects login for an unknown email with the same error as a wrong password', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'whatever123' })
      .expect(401);

    expect(res.body.message).toBe('Invalid email or password');
  });

  it('rejects unauthenticated access to a protected route', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  });

  it('allows access to a protected route with a valid access token', async () => {
    const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.role).toBe(StaffRole.OWNER_ADMIN);
  });

  it('rotates the refresh token and rejects reuse of the old one', async () => {
    const { refreshToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);

    expect(refreshed.body.refreshToken).not.toBe(refreshToken);

    // The original (now-rotated) refresh token must no longer work.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    // The newly issued refresh token still works.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: refreshed.body.refreshToken })
      .expect(200);
  });

  it('revokes a refresh token on logout so it can no longer be used', async () => {
    const { refreshToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken })
      .expect(204);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
  });

  it('rejects access from a deactivated staff account even with a still-valid access token', async () => {
    const { accessToken, staffId } = await createStaffAndLogin(app, StaffRole.CATALOG_MANAGER);

    // Deactivate directly via an owner admin so the same access token
    // (already issued) is exercised against a now-inactive account.
    const owner = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN, {
      email: 'owner2@test.local',
      password: 'owner-password-123',
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/staff/${staffId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ isActive: false })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
  });

  describe('role-based access to staff management', () => {
    it('denies a CATALOG_MANAGER from listing staff', async () => {
      const { accessToken } = await createStaffAndLogin(app, StaffRole.CATALOG_MANAGER);

      await request(app.getHttpServer())
        .get('/api/v1/admin/staff')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });

    it('allows an OWNER_ADMIN to list staff', async () => {
      const { accessToken } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

      await request(app.getHttpServer())
        .get('/api/v1/admin/staff')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });

    it('prevents an OWNER_ADMIN from deactivating their own account', async () => {
      const { accessToken, staffId } = await createStaffAndLogin(app, StaffRole.OWNER_ADMIN);

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/staff/${staffId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ isActive: false })
        .expect(400);
    });
  });
});
