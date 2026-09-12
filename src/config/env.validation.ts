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

// No payment provider has been selected/confirmed for this business (see
// docs/DECISIONS.md). `None` disables public order creation entirely
// (503) so the storefront cannot silently accept orders nobody can pay
// for. `MockDevOnly` is a clearly-labeled, non-production simulation that
// lets the order pipeline itself be exercised end-to-end in dev/test
// without a real payment integration - see docs/BUSINESS_RULES.md
// "Payment scope". It is refused at startup outside development/test.
enum PaymentMethod {
  None = 'none',
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
