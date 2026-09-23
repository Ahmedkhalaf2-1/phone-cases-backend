import type { ConfigService } from '@nestjs/config';
import { MediaStorageDriver as MediaStorageDriverEnum } from '../../src/config/env.validation';
import { LocalMediaStorageService } from '../../src/modules/catalog/media/storage/local-media-storage.service';
import type { MediaStorageDriver } from '../../src/modules/catalog/media/storage/media-storage.interface';

/**
 * Reuses the real `LocalMediaStorageService` (src/modules/catalog/media/
 * storage/local-media-storage.service.ts) outside Nest's DI container -
 * this script never uploads through a parallel storage path. The service
 * only calls `configService.getOrThrow(key)`, so a tiny shim reading
 * `process.env` (already loaded via `dotenv/config`, same as
 * prisma/seed.ts) is enough; it's cast to `ConfigService` purely to
 * satisfy the constructor's type, matching a common pattern for reusing
 * Nest providers from a standalone script.
 *
 * Only MEDIA_STORAGE_DRIVER=local is supported here, same as the real
 * app: MEDIA_STORAGE_DRIVER=s3 fails loudly (S3 isn't implemented yet -
 * see UnavailableMediaStorageService) rather than silently doing
 * something else.
 */
export function createMediaStorage(): MediaStorageDriver {
  const driver = process.env.MEDIA_STORAGE_DRIVER ?? MediaStorageDriverEnum.Local;
  if (driver !== MediaStorageDriverEnum.Local) {
    throw new Error(
      `MEDIA_STORAGE_DRIVER=${driver} is configured but this import tool only supports ` +
        `"local" (the real S3 driver isn't implemented yet - see ` +
        `UnavailableMediaStorageService). Set MEDIA_STORAGE_DRIVER=local to run the import.`,
    );
  }

  const configShim = {
    getOrThrow<T = string>(key: string): T {
      const value = process.env[key];
      if (value === undefined) {
        throw new Error(`Missing required environment variable "${key}"`);
      }
      return value as unknown as T;
    },
  } as unknown as ConfigService;

  return new LocalMediaStorageService(configShim);
}
