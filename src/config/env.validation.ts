import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

enum MediaStorageDriver {
  Local = 'local',
  S3 = 's3',
}

// `None` disables public order creation entirely (503) so the storefront
// cannot silently accept orders nobody can pay for. `Manual` is the
// confirmed, production-valid setting: two manual payment methods (cash on
// delivery, InstaPay bank transfer verified by staff from an uploaded
// screenshot) - no online payment gateway - see docs/DECISIONS.md.
// `MockDevOnly` is a clearly-labeled, non-production simulation kept for
// dev/test convenience; it behaves the same as `Manual` (order acceptance
// enabled) but is refused at startup outside development/test, so a real
// deployment is never accidentally left on the "simulation" setting.
enum PaymentMethod {
  None = 'none',
  Manual = 'manual',
  MockDevOnly = 'mock_dev_only',
}

class EnvironmentVariables {
  @IsIn(Object.values(NodeEnv))
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  APP_URL!: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsOptional()
  @IsString()
  TEST_DATABASE_URL?: string;

  @IsString()
  @MinLength(32, {
    message: 'JWT_ACCESS_SECRET must be at least 32 characters long',
  })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_EXPIRES_IN: string = '15m';

  @IsString()
  @MinLength(32, {
    message: 'JWT_REFRESH_SECRET must be at least 32 characters long',
  })
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_EXPIRES_IN: string = '7d';

  @IsString()
  @IsNotEmpty()
  CORS_ORIGINS: string = '';

  @IsIn(Object.values(MediaStorageDriver))
  MEDIA_STORAGE_DRIVER: MediaStorageDriver = MediaStorageDriver.Local;

  @IsString()
  @IsNotEmpty()
  MEDIA_LOCAL_DIR: string = 'uploads';

  @IsInt()
  @Min(1)
  MEDIA_MAX_FILE_SIZE_BYTES: number = 5 * 1024 * 1024;

  @IsOptional()
  @IsString()
  MEDIA_S3_ENDPOINT?: string;

  @IsOptional()
  @IsString()
  MEDIA_S3_REGION?: string;

  @IsOptional()
  @IsString()
  MEDIA_S3_BUCKET?: string;

  @IsOptional()
  @IsString()
  MEDIA_S3_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  MEDIA_S3_SECRET_ACCESS_KEY?: string;

  @IsOptional()
  @IsString()
  MEDIA_S3_PUBLIC_URL_BASE?: string;

  @IsString()
  @IsNotEmpty()
  DEFAULT_CURRENCY: string = 'EGP';

  @IsIn(Object.values(PaymentMethod))
  PAYMENT_METHOD: PaymentMethod = PaymentMethod.None;

  @IsInt()
  @Min(1)
  RESERVATION_TTL_MINUTES: number = 15;

  // How long an INSTAPAY_MANUAL order's stock reservation is held before
  // it expires - deliberately separate from RESERVATION_TTL_MINUTES (and
  // normally much longer) so a customer doesn't lose their stock hold
  // while their bank transfer/screenshot review is still in progress. See
  // docs/BUSINESS_RULES.md "InstaPay review deadline".
  @IsInt()
  @Min(1)
  INSTAPAY_REVIEW_DEADLINE_MINUTES: number = 1440;

  // Payment receipts (InstaPay screenshots) are stored privately, never
  // under MEDIA_LOCAL_DIR (which is served publicly at /uploads) - see
  // src/modules/payments/receipts/receipt-storage.
  @IsString()
  @IsNotEmpty()
  RECEIPT_LOCAL_DIR: string = 'private-uploads/receipts';

  @IsInt()
  @Min(1)
  RECEIPT_MAX_FILE_SIZE_BYTES: number = 5 * 1024 * 1024;

  // How long an uploaded receipt stays usable before it's attached to an
  // order - long enough to survive a checkout retry, short enough that
  // abandoned uploads don't accumulate forever. See ReceiptCleanupService.
  @IsInt()
  @Min(1)
  RECEIPT_UNATTACHED_RETENTION_MINUTES: number = 120;

  // Caps how many not-yet-attached receipts one guest cart can have at
  // once, independent of the global upload rate limit - see
  // ReceiptsService.assertPendingUploadQuota.
  @IsInt()
  @Min(1)
  RECEIPT_MAX_PENDING_PER_CART: number = 5;
}

export function validateEnv(config: Record<string, unknown>): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const message = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${message}`);
  }

  if (
    validatedConfig.MEDIA_STORAGE_DRIVER === MediaStorageDriver.S3 &&
    (!validatedConfig.MEDIA_S3_BUCKET ||
      !validatedConfig.MEDIA_S3_ACCESS_KEY_ID ||
      !validatedConfig.MEDIA_S3_SECRET_ACCESS_KEY ||
      !validatedConfig.MEDIA_S3_PUBLIC_URL_BASE)
  ) {
    throw new Error(
      'MEDIA_STORAGE_DRIVER=s3 requires MEDIA_S3_BUCKET, MEDIA_S3_ACCESS_KEY_ID, ' +
        'MEDIA_S3_SECRET_ACCESS_KEY and MEDIA_S3_PUBLIC_URL_BASE to be set',
    );
  }

  if (validatedConfig.NODE_ENV === NodeEnv.Production) {
    const insecureDefaults = ['change-me', 'replace-with', 'example', 'dev-secret'];
    const secrets = [validatedConfig.JWT_ACCESS_SECRET, validatedConfig.JWT_REFRESH_SECRET];
    for (const secret of secrets) {
      if (insecureDefaults.some((needle) => secret.toLowerCase().includes(needle))) {
        throw new Error(
          'Refusing to start in production with a JWT secret that looks like a placeholder default',
        );
      }
    }

    if (validatedConfig.PAYMENT_METHOD === PaymentMethod.MockDevOnly) {
      throw new Error(
        'PAYMENT_METHOD=mock_dev_only is a development/test-only simulation and must never run in ' +
          'production. Leave PAYMENT_METHOD=none until a real payment provider is selected and ' +
          'integrated (see docs/DECISIONS.md).',
      );
    }
  }

  return validatedConfig;
}

export { EnvironmentVariables, MediaStorageDriver, NodeEnv, PaymentMethod };
