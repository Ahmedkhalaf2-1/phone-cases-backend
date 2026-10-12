import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  MediaStorageDriver,
  SavedFile,
  SavedFileWithOriginal,
  StorableFile,
} from './media-storage.interface';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const DERIVATIVE_EXTENSION = 'webp';
const ORIGINAL_EXTENSIONS = ['jpg', 'png'];

@Injectable()
export class LocalMediaStorageService implements MediaStorageDriver {
  private readonly logger = new Logger(LocalMediaStorageService.name);
  private readonly rootDir: string;
  private readonly baseUrl: string;

  constructor(configService: ConfigService) {
    this.rootDir = path.resolve(process.cwd(), configService.getOrThrow<string>('MEDIA_LOCAL_DIR'));
    const origin =
      configService.get<string>('PUBLIC_BASE_URL') || configService.getOrThrow<string>('APP_URL');
    this.baseUrl = `${origin.replace(/\/+$/, '')}/uploads`;
  }

  async save(buffer: Buffer, _originalFilename: string, mimeType: string): Promise<SavedFile> {
    const extension = EXTENSION_BY_MIME[mimeType] ?? 'bin';
    const storageKey = `${randomUUID()}.${extension}`;
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(path.join(this.rootDir, storageKey), buffer);
    return { storageKey, url: `${this.baseUrl}/${storageKey}` };
  }

  async saveWithOriginal(
    original: StorableFile,
    derivative: StorableFile,
  ): Promise<SavedFileWithOriginal> {
    const id = randomUUID();
    const originalKey = `${id}.${EXTENSION_BY_MIME[original.mimeType] ?? 'bin'}`;
    const derivativeKey = `${id}.${EXTENSION_BY_MIME[derivative.mimeType] ?? 'bin'}`;
    await mkdir(this.rootDir, { recursive: true });
    try {
      await writeFile(path.join(this.rootDir, originalKey), original.buffer);
      await writeFile(path.join(this.rootDir, derivativeKey), derivative.buffer);
    } catch (error) {
      await Promise.all([this.removeFile(originalKey), this.removeFile(derivativeKey)]);
      throw error;
    }
    return {
      storageKey: derivativeKey,
      url: `${this.baseUrl}/${derivativeKey}`,
      originalStorageKey: originalKey,
    };
  }

  async delete(storageKey: string): Promise<void> {
    await this.removeFile(storageKey);
    // A `.webp` key may be a derivative whose original sits next to it
    // under the same id. Keys with no such sibling (every pre-existing
    // record) make these removals no-ops.
    const extension = path.extname(storageKey).slice(1);
    if (extension === DERIVATIVE_EXTENSION) {
      const id = storageKey.slice(0, -(extension.length + 1));
      await Promise.all(ORIGINAL_EXTENSIONS.map((ext) => this.removeFile(`${id}.${ext}`)));
    }
  }

  private async removeFile(storageKey: string): Promise<void> {
    try {
      await rm(path.join(this.rootDir, storageKey), { force: true });
    } catch (error) {
      this.logger.warn(`Failed to delete local media file "${storageKey}": ${String(error)}`);
    }
  }
}
