import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MediaStorageDriver, SavedFile } from './media-storage.interface';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

@Injectable()
export class LocalMediaStorageService implements MediaStorageDriver {
  private readonly logger = new Logger(LocalMediaStorageService.name);
  private readonly rootDir: string;
  private readonly baseUrl: string;

  constructor(configService: ConfigService) {
    this.rootDir = path.resolve(process.cwd(), configService.getOrThrow<string>('MEDIA_LOCAL_DIR'));
    this.baseUrl = `${configService.getOrThrow<string>('APP_URL')}/uploads`;
  }

  async save(buffer: Buffer, _originalFilename: string, mimeType: string): Promise<SavedFile> {
    const extension = EXTENSION_BY_MIME[mimeType] ?? 'bin';
    const storageKey = `${randomUUID()}.${extension}`;
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(path.join(this.rootDir, storageKey), buffer);
    return { storageKey, url: `${this.baseUrl}/${storageKey}` };
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await rm(path.join(this.rootDir, storageKey), { force: true });
    } catch (error) {
      this.logger.warn(`Failed to delete local media file "${storageKey}": ${String(error)}`);
    }
  }
}
