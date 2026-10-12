import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuditLogService } from '../../audit-log/audit-log.service';
import type { AuthenticatedStaff } from '../../auth/types/authenticated-staff.type';
import { MediaService } from './media.service';
import { LocalMediaStorageService } from './storage/local-media-storage.service';

const ACTOR = { id: 'staff-1' } as AuthenticatedStaff;

function multerFile(buffer: Buffer, mimetype: string): Express.Multer.File {
  return { buffer, mimetype, size: buffer.length, originalname: 'upload' } as Express.Multer.File;
}

async function rawImage(width: number, height: number, format: 'jpeg' | 'png'): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } },
  });
  return format === 'jpeg' ? base.jpeg().toBuffer() : base.png().toBuffer();
}

describe('MediaService.upload', () => {
  let dir: string;
  let storage: LocalMediaStorageService;
  let prismaCreate: jest.Mock;
  let service: MediaService;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'media-service-'));
    storage = new LocalMediaStorageService({
      getOrThrow: (key: string) => (key === 'MEDIA_LOCAL_DIR' ? dir : 'http://localhost:3000'),
      get: () => undefined,
    } as unknown as ConfigService);
    prismaCreate = jest.fn(({ data }) => Promise.resolve({ id: 'asset-1', ...data }));
    service = new MediaService(
      { mediaAsset: { create: prismaCreate } } as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditLogService,
      storage,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['image/jpeg', 'jpeg', 'jpg'],
    ['image/png', 'png', 'png'],
  ] as const)(
    'turns a %s upload into a webp derivative and keeps the original',
    async (mime, format, ext) => {
      const original = await rawImage(120, 80, format);

      const asset = await service.upload(multerFile(original, mime), {}, ACTOR);

      expect(asset.mimeType).toBe('image/webp');
      expect(asset.storageKey).toMatch(/^[0-9a-f-]{36}\.webp$/);
      expect(asset.url).toBe(`http://localhost:3000/uploads/${asset.storageKey}`);
      expect(asset.width).toBe(120);
      expect(asset.height).toBe(80);

      const derivative = await readFile(path.join(dir, asset.storageKey));
      expect(asset.fileSizeBytes).toBe(derivative.length);
      const meta = await sharp(derivative).metadata();
      expect(meta.format).toBe('webp');
      expect([meta.width, meta.height]).toEqual([120, 80]);

      const originalKey = asset.storageKey.replace(/\.webp$/, `.${ext}`);
      expect(await readFile(path.join(dir, originalKey))).toEqual(original);
    },
  );

  it('applies EXIF orientation once and reports oriented dimensions', async () => {
    const rotated = await sharp({
      create: { width: 100, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const asset = await service.upload(multerFile(rotated, 'image/jpeg'), {}, ACTOR);

    expect([asset.width, asset.height]).toEqual([40, 100]);
    const meta = await sharp(await readFile(path.join(dir, asset.storageKey))).metadata();
    expect([meta.width, meta.height]).toEqual([40, 100]);
  });

  it('stores WebP and GIF uploads as-is with no derivative', async () => {
    const webp = await sharp({
      create: { width: 30, height: 20, channels: 3, background: '#fff' },
    })
      .webp()
      .toBuffer();
    const gif = await sharp({
      create: { width: 30, height: 20, channels: 3, background: '#fff' },
    })
      .gif()
      .toBuffer();

    const webpAsset = await service.upload(multerFile(webp, 'image/webp'), {}, ACTOR);
    const gifAsset = await service.upload(multerFile(gif, 'image/gif'), {}, ACTOR);

    expect(webpAsset.mimeType).toBe('image/webp');
    expect(await readFile(path.join(dir, webpAsset.storageKey))).toEqual(webp);
    expect(gifAsset.mimeType).toBe('image/gif');
    expect(gifAsset.storageKey).toMatch(/\.gif$/);
    expect(await readFile(path.join(dir, gifAsset.storageKey))).toEqual(gif);
    expect(await readdir(dir)).toHaveLength(2);
  });

  it('rejects undecodable files without writing anything', async () => {
    await expect(
      service.upload(multerFile(Buffer.from('not an image'), 'image/jpeg'), {}, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await readdir(dir)).toEqual([]);
    expect(prismaCreate).not.toHaveBeenCalled();
  });

  it('rejects unsupported MIME types', async () => {
    await expect(
      service.upload(multerFile(Buffer.from('x'), 'application/pdf'), {}, ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removes both files when the DB insert fails', async () => {
    prismaCreate.mockRejectedValueOnce(new Error('db down'));
    const original = await rawImage(50, 50, 'jpeg');

    await expect(service.upload(multerFile(original, 'image/jpeg'), {}, ACTOR)).rejects.toThrow(
      'db down',
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('removes the file when the DB insert fails for a passthrough upload', async () => {
    prismaCreate.mockRejectedValueOnce(new Error('db down'));
    const webp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#000' },
    })
      .webp()
      .toBuffer();

    await expect(service.upload(multerFile(webp, 'image/webp'), {}, ACTOR)).rejects.toThrow(
      'db down',
    );
    expect(await readdir(dir)).toEqual([]);
  });
});
