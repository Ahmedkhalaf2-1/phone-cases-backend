import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  CustomDesignStorageDriver,
  SavedCustomDesignFile,
} from './custom-design-storage.interface';

/**
 * Mirrors UnavailableReceiptStorageService: MEDIA_STORAGE_DRIVER=s3 is
 * reused to select this storage driver too (one config knob, see
 * docs/DECISIONS.md), and real S3 support is out of scope here just like it
 * already is for media/receipts - this fails loudly instead of silently
 * misbehaving.
 */
@Injectable()
export class UnavailableCustomDesignStorageService implements CustomDesignStorageDriver {
  save(): Promise<SavedCustomDesignFile> {
    throw new ServiceUnavailableException(
      'MEDIA_STORAGE_DRIVER=s3 is configured but the S3 storage driver is not implemented yet ' +
        '(custom designs included). Set MEDIA_STORAGE_DRIVER=local for development.',
    );
  }

  read(): Promise<Buffer> {
    throw new ServiceUnavailableException('S3 storage driver is not implemented yet.');
  }

  delete(): Promise<void> {
    throw new ServiceUnavailableException('S3 storage driver is not implemented yet.');
  }
}
