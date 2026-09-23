import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Exact-duplicate key. Two files with the same content (byte-for-byte,
// regardless of filename) always produce the same digest.
export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// Perceptual "difference hash" (dHash): resize to a tiny 9x8 grayscale
// grid and record, per row, whether each pixel is brighter than the next
// one. Two images that look the same (even at very different resolutions
// or compression levels - exactly what a responsive-image scrape produces)
// collapse to the same or a near-identical 64-bit hash, while unrelated
// images differ in roughly half their bits. This never touches the
// original file bytes - it's computed on an in-memory copy purely for
// comparison, see docs note in image-dedupe.util.ts.
// 17x16 (-> 256-bit hash) rather than the more common 9x8/64-bit dHash:
// measured against this project's real source photos, the coarser 64-bit
// grid blurred away too much of the printed design and left the hash
// dominated by the shared white-background/case-silhouette mockup
// template every image in the batch has in common. 256 bits keeps enough
// detail to be a useful (if still imperfect on its own - see
// image-dedupe.util.ts) similarity signal.
const DHASH_WIDTH = 17;
const DHASH_HEIGHT = 16;

export async function dHash(buffer: Buffer): Promise<string> {
  const { data } = await sharp(buffer)
    .resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = '';
  for (let row = 0; row < DHASH_HEIGHT; row++) {
    for (let col = 0; col < DHASH_WIDTH - 1; col++) {
      const left = data[row * DHASH_WIDTH + col];
      const right = data[row * DHASH_WIDTH + col + 1];
      bits += left < right ? '1' : '0';
    }
  }
  // 256 bits -> 64 hex chars, so callers can compare/store it as a plain string.
  return BigInt('0b' + bits)
    .toString(16)
    .padStart(64, '0');
}

export function hammingDistance(hexA: string, hexB: string): number {
  let xor = BigInt('0x' + hexA) ^ BigInt('0x' + hexB);
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}
