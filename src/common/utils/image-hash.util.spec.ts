import sharp from 'sharp';
import { dHash, hammingDistance, sha256Hex } from './image-hash.util';

async function pngOf(fillHex: string, size = 64): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: fillHex,
    },
  })
    .png()
    .toBuffer();
}

// A simple half-black/half-white split, deterministic enough to give dHash
// real edges to detect (a flat single-color image hashes to all-zero bits
// regardless of color, which is too degenerate a fixture for the
// "different images differ a lot" assertions below).
async function splitImage(leftHex: string, rightHex: string, size = 64): Promise<Buffer> {
  const left = await pngOf(leftHex, size / 2);
  const right = await pngOf(rightHex, size / 2);
  return sharp({
    create: { width: size, height: size, channels: 3, background: '#ffffff' },
  })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: right, left: size / 2, top: 0 },
    ])
    .png()
    .toBuffer();
}

// A checkerboard has strong horizontal AND vertical local contrast in
// every row (unlike a single left/right split, whose adjacent-pixel
// contrast is concentrated in one column), so it gives dHash a
// structurally different bit pattern regardless of the actual colors used
// - dHash only "sees" luminance, so two different-hued but same-shaped
// splits can alias to the same hash, which a structurally different
// pattern like this avoids.
async function checkerboardImage(size = 64, cell = 8): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(size * size * channels);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const isBlack = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const value = isBlack ? 0 : 255;
      const offset = (y * size + x) * channels;
      raw[offset] = value;
      raw[offset + 1] = value;
      raw[offset + 2] = value;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels } })
    .png()
    .toBuffer();
}

describe('sha256Hex', () => {
  it('is deterministic for identical bytes', () => {
    const buffer = Buffer.from('hello world');
    expect(sha256Hex(buffer)).toBe(sha256Hex(Buffer.from('hello world')));
  });

  it('differs for different bytes', () => {
    expect(sha256Hex(Buffer.from('a'))).not.toBe(sha256Hex(Buffer.from('b')));
  });
});

describe('dHash', () => {
  it('produces a 64-character hex string', async () => {
    const hash = await dHash(await pngOf('#ff0000'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same image at a different resolution a very close hash', async () => {
    const original = await splitImage('#000000', '#ffffff', 400);
    const resized = await sharp(original).resize(80, 80).png().toBuffer();
    const recompressed = await sharp(original).jpeg({ quality: 40 }).toBuffer();

    const hashOriginal = await dHash(original);
    const hashResized = await dHash(resized);
    const hashRecompressed = await dHash(recompressed);

    expect(hammingDistance(hashOriginal, hashResized)).toBeLessThanOrEqual(6);
    expect(hammingDistance(hashOriginal, hashRecompressed)).toBeLessThanOrEqual(6);
  });

  it('gives structurally different images a hash that is far apart', async () => {
    const a = await splitImage('#000000', '#ffffff', 200);
    const b = await checkerboardImage(200, 25);

    const hashA = await dHash(a);
    const hashB = await dHash(b);

    expect(hammingDistance(hashA, hashB)).toBeGreaterThan(10);
  });
});

describe('hammingDistance', () => {
  it('is 0 for identical hashes', () => {
    expect(hammingDistance('abcdef0123456789', 'abcdef0123456789')).toBe(0);
  });

  it('is 64 for fully inverted 64-bit hashes', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });

  it('counts differing bits symmetrically', () => {
    expect(hammingDistance('0000000000000001', '0000000000000000')).toBe(1);
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
  });
});
