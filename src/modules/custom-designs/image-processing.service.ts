import { BadRequestException, Injectable } from '@nestjs/common';
import { PrintOutputFormat } from '@prisma/client';
import sharp from 'sharp';
import type { PrintSpec } from './print-spec.util';

export interface DecodedImage {
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
}

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

@Injectable()
export class ImageProcessingService {
  /**
   * Validates a multer file's *actual* content (never trusting the
   * declared Content-Type/extension alone) - decodes it with sharp to
   * confirm it is really a JPEG/PNG/WebP image and reads its real
   * dimensions. Same pattern as ReceiptsService.decodeAndValidate.
   */
  async decodeAndValidate(file: Express.Multer.File, maxSizeBytes: number): Promise<DecodedImage> {
    if (file.size > maxSizeBytes) {
      throw new BadRequestException(
        `File is too large (${file.size} bytes) - the maximum is ${maxSizeBytes} bytes`,
      );
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}". Allowed types: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
      );
    }

    const metadata = await sharp(file.buffer)
      .metadata()
      .catch(() => {
        throw new BadRequestException(
          'The uploaded file could not be decoded as a valid image - it may be corrupt or mislabeled',
        );
      });
    if (!metadata.width || !metadata.height) {
      throw new BadRequestException(
        'The uploaded file has no readable image dimensions - it may be corrupt or mislabeled',
      );
    }
    // The declared Content-Type is trusted only after a successful real
    // decode above; still cross-check the *decoded* format against the
    // same allowlist so a file that decodes as, say, TIFF but was sent
    // with a spoofed "image/png" header is caught too.
    if (!metadata.format || !ALLOWED_MIME_TYPES.has(`image/${metadata.format}`)) {
      throw new BadRequestException(
        `The uploaded file's actual content ("${metadata.format ?? 'unknown'}") does not match an allowed image type`,
      );
    }

    return {
      buffer: file.buffer,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      width: metadata.width,
      height: metadata.height,
    };
  }

  /**
   * The minimum source resolution required to render `spec` without ever
   * upscaling: center-crop+cover only ever DOWNSCALES when the source is at
   * least as large as the target on both axes (sharp's `fit: 'cover'`
   * always scales by `max(targetW/srcW, targetH/srcH)`, so that factor is
   * <= 1, i.e. never an upscale, exactly when srcW >= targetW AND
   * srcH >= targetH). Anything smaller is rejected outright rather than
   * silently producing a blurry "high-quality" print file - see product
   * requirement.
   */
  assertMeetsMinimumResolution(image: { width: number; height: number }, spec: PrintSpec): void {
    if (image.width < spec.widthPx || image.height < spec.heightPx) {
      throw new BadRequestException(
        `Image resolution ${image.width}x${image.height} is too low for this variant's print size. ` +
          `A minimum of ${spec.widthPx}x${spec.heightPx} pixels is required so the print file is never ` +
          `upscaled - please upload a higher-resolution image.`,
      );
    }
  }

  /**
   * Renders the print-ready file: automatic center-crop+cover to exactly
   * `spec.widthPx x spec.heightPx`, no manual crop/move/zoom controls, no
   * browser dependency (pure server-side raster with sharp). Never
   * upscales - callers must have already called
   * assertMeetsMinimumResolution first.
   */
  async renderPrintFile(sourceBuffer: Buffer, spec: PrintSpec): Promise<Buffer> {
    let pipeline = sharp(sourceBuffer)
      .resize(spec.widthPx, spec.heightPx, {
        fit: 'cover',
        position: 'centre',
        withoutEnlargement: true,
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } });

    pipeline =
      spec.outputFormat === PrintOutputFormat.PNG
        ? pipeline.png({ quality: spec.outputQuality })
        : pipeline.jpeg({ quality: spec.outputQuality });

    return pipeline.toBuffer();
  }
}
