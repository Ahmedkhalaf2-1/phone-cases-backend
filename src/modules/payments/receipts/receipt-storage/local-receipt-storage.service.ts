import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ReceiptStorageDriver, SavedReceiptFile } from './receipt-storage.interface';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Same generated-filename-on-local-disk approach as
 * LocalMediaStorageService, deliberately pointed at a directory that is
 * NEVER registered with `app.useStaticAssets` (see src/main.ts) - there is
 * no public URL for a receipt, only `read()`, which ReceiptsService calls
 * after its own ownership/role check.
 */
@Injectable()
export class LocalReceiptStorageService implements ReceiptStorageDriver {
  private readonly logger = new Logger(LocalReceiptStorageService.name);
  private readonly rootDir: string;

  constructor(configService: ConfigService) {
    this.rootDir = path.resolve(
      process.cwd(),
      configService.getOrThrow<string>('RECEIPT_LOCAL_DIR'),
    );
  }

  async save(buffer: Buffer, mimeType: string): Promise<SavedReceiptFile> {
    const extension = EXTENSION_BY_MIME[mimeType] ?? 'bin';
    const storageKey = `${randomUUID()}.${extension}`;
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(path.join(this.rootDir, storageKey), buffer);
    return { storageKey };
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFile(path.join(this.rootDir, storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await rm(path.join(this.rootDir, storageKey), { force: true });
    } catch (error) {
      this.logger.warn(`Failed to delete receipt file "${storageKey}": ${String(error)}`);
    }
  }
}
