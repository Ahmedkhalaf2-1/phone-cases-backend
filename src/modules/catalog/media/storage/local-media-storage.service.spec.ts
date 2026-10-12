import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { LocalMediaStorageService } from './local-media-storage.service';

describe('LocalMediaStorageService', () => {
  let dir: string;
  let service: LocalMediaStorageService;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'media-storage-'));
    const config = {
      getOrThrow: (key: string) => (key === 'MEDIA_LOCAL_DIR' ? dir : 'http://localhost:3000'),
      get: () => undefined,
    } as unknown as ConfigService;
    service = new LocalMediaStorageService(config);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes original and derivative under one id; key/url point to the derivative', async () => {
    const original = Buffer.from('original-bytes');
    const derivative = Buffer.from('derivative-bytes');

    const saved = await service.saveWithOriginal(
      { buffer: original, mimeType: 'image/jpeg' },
      { buffer: derivative, mimeType: 'image/webp' },
    );

    expect(saved.storageKey).toMatch(/^[0-9a-f-]{36}\.webp$/);
    expect(saved.originalStorageKey).toBe(saved.storageKey.replace(/\.webp$/, '.jpg'));
    expect(saved.url).toBe(`http://localhost:3000/uploads/${saved.storageKey}`);
    expect(await readFile(path.join(dir, saved.originalStorageKey))).toEqual(original);
    expect(await readFile(path.join(dir, saved.storageKey))).toEqual(derivative);
  });

  it('delete removes the derivative and its original sibling', async () => {
    const saved = await service.saveWithOriginal(
      { buffer: Buffer.from('o'), mimeType: 'image/png' },
      { buffer: Buffer.from('d'), mimeType: 'image/webp' },
    );

    await service.delete(saved.storageKey);

    expect(await readdir(dir)).toEqual([]);
  });

  it('delete of a legacy key removes only that file', async () => {
    await writeFile(path.join(dir, 'aaaa.jpg'), 'x');
    await writeFile(path.join(dir, 'bbbb.jpg'), 'y');

    await service.delete('aaaa.jpg');

    expect(await readdir(dir)).toEqual(['bbbb.jpg']);
  });

  it('leaves no files behind when a write fails', async () => {
    // A directory squatting on the derivative path is impossible to predict,
    // so force the failure with an unwritable root instead.
    const broken = new LocalMediaStorageService({
      getOrThrow: (key: string) =>
        key === 'MEDIA_LOCAL_DIR' ? path.join(dir, 'file-not-dir') : 'http://localhost:3000',
      get: () => undefined,
    } as unknown as ConfigService);
    await writeFile(path.join(dir, 'file-not-dir'), 'blocker');

    await expect(
      broken.saveWithOriginal(
        { buffer: Buffer.from('o'), mimeType: 'image/jpeg' },
        { buffer: Buffer.from('d'), mimeType: 'image/webp' },
      ),
    ).rejects.toBeDefined();
    expect(await readdir(dir)).toEqual(['file-not-dir']);
  });
});
