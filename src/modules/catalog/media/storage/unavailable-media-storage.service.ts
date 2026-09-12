import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { MediaStorageDriver, SavedFile } from './media-storage.interface';

/**
 * Placeholder for the production object-storage driver (S3-compatible).
 * Real S3 integration is Phase 4 scope ("Production media integration",
 * see docs/SYSTEM_PLAN.md) - this driver exists only so
 * MEDIA_STORAGE_DRIVER=s3 fails loudly and explicitly instead of silently
 * behaving like local storage or crashing with an unrelated error.
 */
@Injectable()
export class UnavailableMediaStorageService implements MediaStorageDriver {
  save(): Promise<SavedFile> {
    throw new ServiceUnavailableException(
      'MEDIA_STORAGE_DRIVER=s3 is configured but the S3 storage driver is not implemented yet ' +
        '(planned for Phase 4). Set MEDIA_STORAGE_DRIVER=local for development.',
    );
  }

  delete(): Promise<void> {
    throw new ServiceUnavailableException('S3 storage driver is not implemented yet.');
  }
}
