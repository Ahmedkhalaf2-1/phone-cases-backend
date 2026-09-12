import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { StaffRole } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

export async function createTestApp(): Promise<INestApplication> {
  // NODE_ENV=test (set in test/jest-setup-env.ts) makes AppModule skip
  // registering the global ThrottlerGuard - see the comment in
  // src/app.module.ts for why these functional tests don't go through it.
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  await app.init();
  return app;
}

export async function resetDatabase(app: INestApplication): Promise<void> {
  const prisma = app.get(PrismaService);
  await prisma.cleanDatabaseForTests();
}

export async function createStaffAndLogin(
  app: INestApplication,
  role: StaffRole,
  overrides: { email?: string; password?: string } = {},
): Promise<{ accessToken: string; refreshToken: string; staffId: string }> {
  const prisma = app.get(PrismaService);
  const email = overrides.email ?? `${role.toLowerCase()}@test.local`;
  const password = overrides.password ?? 'staff-password-123';
  const staff = await prisma.staffUser.create({
    data: {
      email,
      fullName: `Test ${role}`,
      role,
      passwordHash: await bcrypt.hash(password, 4),
    },
  });

  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(200);

  return {
    accessToken: response.body.accessToken,
    refreshToken: response.body.refreshToken,
    staffId: staff.id,
  };
}
