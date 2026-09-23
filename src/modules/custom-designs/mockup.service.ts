import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';

/**
 * One fixed generic mockup canvas used for EVERY variant's preview,
 * regardless of the variant's own print spec (see product requirement -
 * the preview is intentionally not model-accurate; only the print-ready
 * file uses the real print dimensions). `printArea` is where a design gets
 * composited within that canvas.
 */
const MOCKUP_WIDTH = 1400;
const MOCKUP_HEIGHT = 2600;
const PRINT_AREA = { left: 100, top: 100, width: 1200, height: 2400 };

/**
 * Generates (once, cached in memory) a simple built-in generic phone-case
 * silhouette to composite designs onto, so the feature works with zero
 * asset setup out of the box. If CUSTOM_DESIGN_MOCKUP_IMAGE_PATH is set,
 * that image is used instead - it is composited on TOP of the (resized,
 * cropped-to-cover) design at the same `printArea`, so a real asset should
 * be prepared with a transparent window over that same region for the
 * design to show through. See docs on env.validation.ts.
 */
@Injectable()
export class MockupService {
  private readonly logger = new Logger(MockupService.name);
  private cachedFrame: Promise<Buffer> | null = null;

  constructor(private readonly configService: ConfigService) {}

  getCanvasSize(): { width: number; height: number } {
    return { width: MOCKUP_WIDTH, height: MOCKUP_HEIGHT };
  }

  getPrintArea(): { left: number; top: number; width: number; height: number } {
    return PRINT_AREA;
  }

  /**
   * Composites `designBuffer` (any image buffer/aspect - resized with
   * cover+center-crop to exactly fill the print area, upscaling allowed
   * since this is a preview only) under the mockup frame and returns a
   * single flattened JPEG preview buffer.
   */
  async composePreview(designBuffer: Buffer): Promise<Buffer> {
    const resizedDesign = await sharp(designBuffer)
      .resize(PRINT_AREA.width, PRINT_AREA.height, { fit: 'cover', position: 'centre' })
      .toBuffer();

    const frame = await this.getFrame();

    return sharp({
      create: {
        width: MOCKUP_WIDTH,
        height: MOCKUP_HEIGHT,
        channels: 4,
        background: { r: 235, g: 235, b: 238, alpha: 1 },
      },
    })
      .composite([
        { input: resizedDesign, left: PRINT_AREA.left, top: PRINT_AREA.top },
        { input: frame, left: 0, top: 0 },
      ])
      .flatten({ background: { r: 235, g: 235, b: 238 } })
      .jpeg({ quality: 88 })
      .toBuffer();
  }

  private async getFrame(): Promise<Buffer> {
    if (!this.cachedFrame) {
      this.cachedFrame = this.loadOrBuildFrame().catch((error) => {
        // Never let a bad configured asset permanently wedge the cache -
        // the next upload falls back to the built-in frame and retries.
        this.cachedFrame = null;
        throw error;
      });
    }
    return this.cachedFrame;
  }

  private async loadOrBuildFrame(): Promise<Buffer> {
    const configuredPath = this.configService.get<string>('CUSTOM_DESIGN_MOCKUP_IMAGE_PATH');
    if (configuredPath) {
      try {
        const absolute = path.resolve(process.cwd(), configuredPath);
        const raw = await readFile(absolute);
        return sharp(raw).resize(MOCKUP_WIDTH, MOCKUP_HEIGHT, { fit: 'fill' }).png().toBuffer();
      } catch (error) {
        this.logger.warn(
          `Failed to load CUSTOM_DESIGN_MOCKUP_IMAGE_PATH="${configuredPath}", falling back to the ` +
            `built-in placeholder mockup: ${String(error)}`,
        );
      }
    }
    return this.buildPlaceholderFrame();
  }

  /**
   * A generic rounded phone-case silhouette with a transparent window over
   * `printArea` (so the composited design shows through) and a small
   * camera-module cutout near the top - just enough to read as "a phone
   * case" without pretending to be any specific real device.
   */
  private async buildPlaceholderFrame(): Promise<Buffer> {
    const outerRadius = 140;
    const windowRadius = 60;
    const cameraSize = 220;
    const cameraLeft = PRINT_AREA.left + 60;
    const cameraTop = PRINT_AREA.top + 60;

    const svg = `
      <svg width="${MOCKUP_WIDTH}" height="${MOCKUP_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <mask id="window-mask">
            <rect x="0" y="0" width="${MOCKUP_WIDTH}" height="${MOCKUP_HEIGHT}" fill="white" />
            <rect x="${PRINT_AREA.left}" y="${PRINT_AREA.top}" width="${PRINT_AREA.width}" height="${PRINT_AREA.height}" rx="${windowRadius}" fill="black" />
          </mask>
        </defs>
        <rect x="0" y="0" width="${MOCKUP_WIDTH}" height="${MOCKUP_HEIGHT}" rx="${outerRadius}"
          fill="#d8d8de" stroke="#9a9aa4" stroke-width="10" mask="url(#window-mask)" />
        <rect x="${PRINT_AREA.left}" y="${PRINT_AREA.top}" width="${PRINT_AREA.width}" height="${PRINT_AREA.height}"
          rx="${windowRadius}" fill="none" stroke="#9a9aa4" stroke-width="6" />
        <rect x="${cameraLeft}" y="${cameraTop}" width="${cameraSize}" height="${cameraSize}" rx="48"
          fill="#3a3a40" opacity="0.55" />
        <circle cx="${cameraLeft + cameraSize * 0.28}" cy="${cameraTop + cameraSize * 0.3}" r="46" fill="#1c1c20" opacity="0.85" />
        <circle cx="${cameraLeft + cameraSize * 0.72}" cy="${cameraTop + cameraSize * 0.3}" r="46" fill="#1c1c20" opacity="0.85" />
        <circle cx="${cameraLeft + cameraSize * 0.5}" cy="${cameraTop + cameraSize * 0.72}" r="46" fill="#1c1c20" opacity="0.85" />
      </svg>
    `;

    return sharp(Buffer.from(svg)).png().toBuffer();
  }
}
