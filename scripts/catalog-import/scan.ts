import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import sharp from 'sharp';
import { dHash, sha256Hex } from '../../src/common/utils/image-hash.util';
import type { DedupeCandidate } from '../../src/common/utils/image-dedupe.util';

// Must stay in sync with MediaService.ALLOWED_MIME_TYPES
// (src/modules/catalog/media/media.service.ts) - duplicated here rather
// than imported because that module wires up NestJS providers this
// standalone script does not (and should not) bootstrap.
const EXTENSION_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// Filename substrings identified by direct visual review of this specific
// `photos/` batch (see the import plan) - not a general heuristic, just a
// record of what was manually confirmed to NOT be a product design.
export const KNOWN_NON_DESIGN_PATTERNS: Array<{ substring: string; reason: string }> = [
  {
    substring: '472335667_122109366548661290_338071631450135772_n_2',
    reason: 'Shop\'s own "INCASE" logo, not a product design (confirmed by visual review).',
  },
  {
    substring: 'WhatsApp_Image_2025-07-23_at_4.25.08_PM_c717deba-8d6b-4800-ab3b-b1e9e3ea82bf',
    reason:
      'Reused third-party stock photo of a plain clear case (third-party branding visible in ' +
      'shot), not an original design (confirmed by visual review).',
  },
  {
    substring: 'WhatsApp_Image_2025-07-23_at_4.25.08_PM_70f1c6cf-875e-4da8-9158-cf9c336a0241',
    reason:
      'Reused third-party stock photo of a plain clear case (third-party branding visible in ' +
      'shot), not an original design (confirmed by visual review).',
  },
  {
    substring: 'WhatsApp_Image_2025-07-23_at_4.25.08_PM_54d64069-dc45-4063-a1b2-85df12299741',
    reason:
      'Reused third-party stock photo of a plain clear case (third-party branding visible in ' +
      'shot), not an original design (confirmed by visual review).',
  },
  {
    substring: 'WhatsApp_Image_2025-07-23_at_4.25.08_PM_4d104ac7-4520-4a78-bcd1-a9c3ae62ec08',
    reason:
      'Reused third-party stock photo of a plain clear case (third-party branding visible in ' +
      'shot), not an original design (confirmed by visual review).',
  },
  {
    substring: 'WhatsApp-Image-2024-08-18-at-9.14.03-PM_ecf5beee-b170-4a24-86b3-937c260ac50d',
    reason:
      'Reused third-party stock photo of a plain clear case (third-party branding visible in ' +
      'shot), not an original design (confirmed by visual review).',
  },
];

// This specific `photos/` batch was scraped from a WooCommerce-style
// responsive image gallery: every filename is `imgi_<scrapeOrder>_<design
// name>.<ext>`, and the same design is re-saved once per responsive
// breakpoint (confirmed by direct visual review - see the import plan).
// Stripping the scrape-order prefix recovers a reliable "same source
// design" grouping key - this turned out to be far more reliable for this
// dataset than perceptual hashing alone (see the comment on
// NEAR_DUPLICATE_HAMMING_THRESHOLD in image-dedupe.util.ts for why: every
// photo shares the same white-background/case-silhouette mockup template,
// which swamps a generic perceptual hash). Falls back to the bare filename
// (still a stable, if less useful, grouping key) for anything that doesn't
// match the `imgi_N_` convention.
const SCRAPE_PREFIX_PATTERN = /^imgi_\d+_/;

export function deriveGroupKey(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  return withoutExtension.replace(SCRAPE_PREFIX_PATTERN, '');
}

export interface ScanExclusion {
  filename: string;
  reason: string;
}

export interface ScanResult {
  candidates: DedupeCandidate[];
  excluded: ScanExclusion[];
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

export async function scanSourceFolder(sourceDir: string): Promise<ScanResult> {
  const files = (await listFilesRecursive(sourceDir)).sort();
  const candidates: DedupeCandidate[] = [];
  const excluded: ScanExclusion[] = [];

  for (const filePath of files) {
    const filename = path.basename(filePath);

    const knownNonDesign = KNOWN_NON_DESIGN_PATTERNS.find((p) =>
      filename.includes(p.substring),
    );
    if (knownNonDesign) {
      excluded.push({ filename, reason: knownNonDesign.reason });
      continue;
    }

    const extension = path.extname(filename).toLowerCase();
    const mimeType = EXTENSION_TO_MIME[extension];
    if (!mimeType) {
      excluded.push({
        filename,
        reason: `Unsupported file type "${extension || '(none)'}" - the media system only ` +
          `accepts ${Object.values(EXTENSION_TO_MIME).join(', ')}.`,
      });
      continue;
    }

    const buffer = await readFile(filePath);

    let width: number | undefined;
    let height: number | undefined;
    try {
      const metadata = await sharp(buffer).metadata();
      width = metadata.width;
      height = metadata.height;
    } catch {
      excluded.push({ filename, reason: 'Could not be decoded as a valid image (corrupt or mislabeled).' });
      continue;
    }
    if (!width || !height) {
      excluded.push({ filename, reason: 'Image has no readable dimensions.' });
      continue;
    }

    candidates.push({
      id: filePath,
      filename,
      sha256: sha256Hex(buffer),
      phash: await dHash(buffer),
      width,
      height,
      fileSizeBytes: buffer.byteLength,
      groupKey: deriveGroupKey(filename),
    });
  }

  return { candidates, excluded };
}
