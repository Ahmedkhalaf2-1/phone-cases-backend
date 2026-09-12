import 'reflect-metadata';
import * as path from 'node:path';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.use(helmet());
  app.enableCors({
    origin: configService
      .getOrThrow<string>('CORS_ORIGINS')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    credentials: true,
  });

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

  // Development-only local media storage. Production serves media from
  // object storage instead (see docs/SYSTEM_PLAN.md, Phase 4).
  if (configService.getOrThrow<string>('MEDIA_STORAGE_DRIVER') === 'local') {
    app.useStaticAssets(
      path.resolve(process.cwd(), configService.getOrThrow<string>('MEDIA_LOCAL_DIR')),
      {
        prefix: '/uploads',
      },
    );
  }

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Phone Cases Backend API')
    .setDescription(
      'Public storefront, admin and webhook API for the phone cases ecommerce backend',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('auth')
    .addTag('products')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = configService.getOrThrow<number>('PORT');
  await app.listen(port);
  logger.log(`Application listening on port ${port}`);
  logger.log(`Swagger docs available at /api/docs`);
}

bootstrap().catch((error) => {
  console.error('Fatal error during bootstrap', error);
  process.exit(1);
});
