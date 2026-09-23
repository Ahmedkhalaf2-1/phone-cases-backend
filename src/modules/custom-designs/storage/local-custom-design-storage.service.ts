import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CustomDesignStorageDriver,
  SavedCustomDesignFile,
} from './custom-design-storage.interface';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Same generated-filename-on-local-disk approach as
 * LocalReceiptStorageService, deliberately pointed at a directory that is
 * NEVER registered with `app.useStaticAssets` (see src/main.ts) - storage
 * keys are deterministic-format but non-guessable (random UUID), and there
 * is no public URL for any custom design file, only `read()`.
 */
@Injectable()
export class LocalCustomDesignStorageService implements CustomDesignStorageDriver {
  private readonly logger = new Logger(LocalCustomDesignStorageService.name);
  private readonly rootDir: string;

  constructor(configService: ConfigService) {
    this.rootDir = path.resolve(
      process.cwd(),
      configService.getOrThrow<string>('CUSTOM_DESIGN_LOCAL_DIR'),
    );
  }

  async save(buffer: Buffer, mimeType: string): Promise<SavedCustomDesignFile> {
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
      this.logger.warn(`Failed to delete custom design file "${storageKey}": ${String(error)}`);
    }
  }
}
