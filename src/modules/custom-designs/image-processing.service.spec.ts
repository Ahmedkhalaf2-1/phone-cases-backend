import { BadRequestException } from '@nestjs/common';
import { PrintOutputFormat } from '@prisma/client';
import sharp from 'sharp';
import { ImageProcessingService } from './image-processing.service';
import type { PrintSpec } from './print-spec.util';

// Image decoding/resizing is genuinely CPU-bound work - give it more room
// than the 5s default under a loaded/sandboxed CI machine, same reasoning
// as other sharp-backed spec files in this repo.
jest.setTimeout(30_000);

async function solidImage(
  width: number,
  height: number,
  format: 'jpeg' | 'png' = 'jpeg',
): Promise<Buffer> {
  const pipeline = sharp({
    create: { width, height, channels: 3, background: '#3366ff' },
  });
  return format === 'png' ? pipeline.png().toBuffer() : pipeline.jpeg().toBuffer();
}

function multerFile(buffer: Buffer, mimetype: string): Express.Multer.File {
  return {
    buffer,
    mimetype,
    size: buffer.byteLength,
    originalname: 'upload',
  } as Express.Multer.File;
}

const SPEC: PrintSpec = {
  widthPx: 400,
  heightPx: 800,
  dpi: 300,
  safeMarginPx: 20,
  outputFormat: PrintOutputFormat.JPEG,
  outputQuality: 90,
};

describe('ImageProcessingService', () => {
  const service = new ImageProcessingService();

  describe('decodeAndValidate', () => {
    it('accepts a valid JPEG and reads its real dimensions', async () => {
      const buffer = await solidImage(600, 900, 'jpeg');
      const decoded = await service.decodeAndValidate(
        multerFile(buffer, 'image/jpeg'),
        10 * 1024 * 1024,
      );
      expect(decoded.width).toBe(600);
      expect(decoded.height).toBe(900);
      expect(decoded.mimeType).toBe('image/jpeg');
    });

    it('rejects a file larger than the configured limit', async () => {
      const buffer = await solidImage(600, 900);
      await expect(
        service.decodeAndValidate(multerFile(buffer, 'image/jpeg'), 10),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unsupported declared mime type', async () => {
      const buffer = await solidImage(600, 900);
      await expect(
        service.decodeAndValidate(multerFile(buffer, 'image/gif'), 10 * 1024 * 1024),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a corrupt/non-image buffer even with an allowed declared mime type', async () => {
      const buffer = Buffer.from('this is not an image');
      await expect(
        service.decodeAndValidate(multerFile(buffer, 'image/png'), 10 * 1024 * 1024),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a real image whose decoded format is allowed even if it differs from the declared mime type', async () => {
      // A real PNG, declared as image/jpeg - both the declared type and
      // the actual decoded format are independently in the allowlist, so
      // this passes (matches ReceiptsService.decodeAndValidate's same
      // documented behavior: the decoded-format check only catches a
      // format that isn't allowed at all, e.g. TIFF/BMP).
      const buffer = await solidImage(600, 900, 'png');
      const decoded = await service.decodeAndValidate(
        multerFile(buffer, 'image/jpeg'),
        10 * 1024 * 1024,
      );
      expect(decoded.width).toBe(600);
    });
  });

  describe('assertMeetsMinimumResolution', () => {
    it('passes when the source exactly matches the print target', () => {
      expect(() =>
        service.assertMeetsMinimumResolution({ width: 400, height: 800 }, SPEC),
      ).not.toThrow();
    });

    it('passes when the source is larger than the print target on both axes', () => {
      expect(() =>
        service.assertMeetsMinimumResolution({ width: 4000, height: 8000 }, SPEC),
      ).not.toThrow();
    });

    it('rejects a source narrower than the print target', () => {
      expect(() => service.assertMeetsMinimumResolution({ width: 399, height: 900 }, SPEC)).toThrow(
        BadRequestException,
      );
    });

    it('rejects a source shorter than the print target', () => {
      expect(() => service.assertMeetsMinimumResolution({ width: 500, height: 799 }, SPEC)).toThrow(
        BadRequestException,
      );
    });
  });

  describe('renderPrintFile', () => {
    it('renders exactly the target canvas size regardless of source aspect ratio', async () => {
      // Source is much wider-than-tall than the (400x800, portrait) target
      // - a correct center-crop+cover must still fill the exact target
      // canvas, cropping the excess width.
      const source = await solidImage(2000, 1000);
      const rendered = await service.renderPrintFile(source, SPEC);
      const metadata = await sharp(rendered).metadata();
      expect(metadata.width).toBe(SPEC.widthPx);
      expect(metadata.height).toBe(SPEC.heightPx);
      expect(metadata.format).toBe('jpeg');
    });

    it('never upscales beyond the source when it exactly matches the target', async () => {
      const source = await solidImage(SPEC.widthPx, SPEC.heightPx);
      const rendered = await service.renderPrintFile(source, SPEC);
      const metadata = await sharp(rendered).metadata();
      expect(metadata.width).toBe(SPEC.widthPx);
      expect(metadata.height).toBe(SPEC.heightPx);
    });

    it('renders as PNG when the spec requests PNG output', async () => {
      const source = await solidImage(SPEC.widthPx, SPEC.heightPx);
      const rendered = await service.renderPrintFile(source, {
        ...SPEC,
        outputFormat: PrintOutputFormat.PNG,
      });
      const metadata = await sharp(rendered).metadata();
      expect(metadata.format).toBe('png');
    });
  });
});
