import {
  DedupeCandidate,
  dedupeCandidates,
  findCrossClusterSimilarities,
} from './image-dedupe.util';

function candidate(overrides: Partial<DedupeCandidate> & { id: string }): DedupeCandidate {
  return {
    filename: `${overrides.id}.jpg`,
    sha256: `sha-${overrides.id}`,
    phash: '0000000000000000',
    width: 100,
    height: 100,
    fileSizeBytes: 1000,
    ...overrides,
  };
}

describe('dedupeCandidates', () => {
  it('leaves unrelated images in their own single-member clusters', () => {
    const items = [
      candidate({ id: 'a', phash: '0000000000000000' }),
      candidate({ id: 'b', phash: 'ffffffffffffffff' }),
    ];

    const clusters = dedupeCandidates(items);

    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.reason)).toEqual(['single', 'single']);
  });

  it('collapses byte-identical files into one exact-duplicate cluster', () => {
    const items = [
      candidate({ id: 'a', sha256: 'same', width: 100, height: 100, fileSizeBytes: 5000 }),
      candidate({ id: 'b', sha256: 'same', width: 100, height: 100, fileSizeBytes: 5000 }),
    ];

    const clusters = dedupeCandidates(items);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].reason).toBe('exact-duplicate');
    expect(clusters[0].members).toHaveLength(2);
  });

  it('collapses near-identical dHashes (same image, different resolution) into one cluster', () => {
    const items = [
      candidate({ id: 'small', phash: '0000000000000000', width: 100, height: 100 }),
      // 3 bits flipped - within threshold.
      candidate({ id: 'large', phash: '0000000000000007', width: 900, height: 900 }),
    ];

    const clusters = dedupeCandidates(items);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].reason).toBe('near-duplicate');
    expect(clusters[0].chosen.id).toBe('large');
  });

  it('does NOT merge images whose hashes differ by more than the threshold (conservative)', () => {
    const items = [
      candidate({ id: 'a', phash: '0000000000000000' }),
      // 0xff flips 8 bits - above NEAR_DUPLICATE_HAMMING_THRESHOLD (6).
      candidate({ id: 'b', phash: '00000000000000ff' }),
    ];

    const clusters = dedupeCandidates(items);

    expect(clusters).toHaveLength(2);
  });

  it('picks the highest-resolution member as the winner', () => {
    const items = [
      candidate({ id: 'small', sha256: 'same', width: 100, height: 100, fileSizeBytes: 1000 }),
      candidate({ id: 'big', sha256: 'same', width: 900, height: 900, fileSizeBytes: 900 }),
    ];

    const [cluster] = dedupeCandidates(items);

    expect(cluster.chosen.id).toBe('big');
  });

  it('falls back to file size when resolution ties', () => {
    const items = [
      candidate({ id: 'lighter', sha256: 'same', width: 500, height: 500, fileSizeBytes: 1000 }),
      candidate({ id: 'heavier', sha256: 'same', width: 500, height: 500, fileSizeBytes: 9000 }),
    ];

    const [cluster] = dedupeCandidates(items);

    expect(cluster.chosen.id).toBe('heavier');
  });

  it('falls back to the cleanest filename when resolution and size tie', () => {
    const items = [
      candidate({
        id: 'noisy',
        sha256: 'same',
        width: 500,
        height: 500,
        fileSizeBytes: 1000,
        filename: 'imgi_10_d9369755-09ef-4045-b123-ac1c165d48c9copy5.jpg',
      }),
      candidate({
        id: 'clean',
        sha256: 'same',
        width: 500,
        height: 500,
        fileSizeBytes: 1000,
        filename: 'imgi_100_MadridRoyaltyPhoneCase.jpg',
      }),
    ];

    const [cluster] = dedupeCandidates(items);

    expect(cluster.chosen.id).toBe('clean');
  });

  it('merges candidates sharing a groupKey regardless of hash distance', () => {
    const items = [
      candidate({ id: 'a', phash: '0000000000000000', groupKey: 'design-x', width: 100 }),
      // Hashes are maximally different, but the groupKey says "same source".
      candidate({
        id: 'b',
        phash: 'f'.repeat(64),
        groupKey: 'design-x',
        width: 900,
        sha256: 'different-bytes',
      }),
    ];

    const clusters = dedupeCandidates(items);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].reason).toBe('same-source-group');
    expect(clusters[0].chosen.id).toBe('b');
  });

  it('does not bridge two different groupKeys just because one member of each is near-duplicate', () => {
    // Reproduces the real failure mode found against the actual photos/
    // batch: three different designs got bridged into one cluster because
    // a noisy pair of low-resolution thumbnails happened to hash close,
    // even though the designs themselves were unrelated. Disabling the
    // perceptual threshold (nearDuplicateHammingThreshold < 0) must stop
    // groupKey-based clusters from being bridged this way.
    const items = [
      candidate({ id: 'a1', groupKey: 'design-a', phash: '0'.repeat(64) }),
      candidate({ id: 'a2', groupKey: 'design-a', phash: '0'.repeat(64) }),
      candidate({ id: 'b1', groupKey: 'design-b', phash: '0'.repeat(64) }), // noisy near match to a*
      candidate({ id: 'b2', groupKey: 'design-b', phash: 'f'.repeat(64) }),
    ];

    const clusters = dedupeCandidates(items, { nearDuplicateHammingThreshold: -1 });

    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.members.length).sort()).toEqual([2, 2]);
  });

  it('a positive threshold can still bridge unrelated groupKeys (why the real import disables it)', () => {
    const items = [
      candidate({ id: 'a1', groupKey: 'design-a', phash: '0'.repeat(64) }),
      candidate({ id: 'b1', groupKey: 'design-b', phash: '0'.repeat(64) }),
    ];

    const clusters = dedupeCandidates(items, { nearDuplicateHammingThreshold: 6 });

    expect(clusters).toHaveLength(1);
  });
});

describe('findCrossClusterSimilarities', () => {
  it('flags perceptually close clusters without merging them', () => {
    const clusters = dedupeCandidates(
      [
        candidate({ id: 'a', groupKey: 'design-a', phash: '0'.repeat(64) }),
        candidate({ id: 'b', groupKey: 'design-b', phash: '0'.repeat(63) + 'f' }),
      ],
      { nearDuplicateHammingThreshold: -1 },
    );

    expect(clusters).toHaveLength(2);

    const flagged = findCrossClusterSimilarities(clusters, 10);
    expect(flagged).toHaveLength(1);
    expect([flagged[0].a.id, flagged[0].b.id].sort()).toEqual(['a', 'b']);
  });

  it('flags nothing when clusters are far apart', () => {
    const clusters = dedupeCandidates(
      [
        candidate({ id: 'a', groupKey: 'design-a', phash: '0'.repeat(64) }),
        candidate({ id: 'b', groupKey: 'design-b', phash: 'f'.repeat(64) }),
      ],
      { nearDuplicateHammingThreshold: -1 },
    );

    expect(findCrossClusterSimilarities(clusters, 10)).toHaveLength(0);
  });
});
