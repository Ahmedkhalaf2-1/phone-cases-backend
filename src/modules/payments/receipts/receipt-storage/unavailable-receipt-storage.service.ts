import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { ReceiptStorageDriver, SavedReceiptFile } from './receipt-storage.interface';

/**
 * Mirrors UnavailableMediaStorageService: MEDIA_STORAGE_DRIVER=s3 is
 * reused to select the receipt storage driver too (one config knob, see
 * docs/DECISIONS.md), and real S3 support for receipts is out of scope
 * here just like it already is for public media - this fails loudly
 * instead of silently misbehaving.
 */
@Injectable()
export class UnavailableReceiptStorageService implements ReceiptStorageDriver {
  save(): Promise<SavedReceiptFile> {
    throw new ServiceUnavailableException(
      'MEDIA_STORAGE_DRIVER=s3 is configured but the S3 storage driver is not implemented yet ' +
        '(receipts included). Set MEDIA_STORAGE_DRIVER=local for development.',
    );
  }

  read(): Promise<Buffer> {
    throw new ServiceUnavailableException('S3 storage driver is not implemented yet.');
  }

  delete(): Promise<void> {
    throw new ServiceUnavailableException('S3 storage driver is not implemented yet.');
  }
}
