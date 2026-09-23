import { hammingDistance } from './image-hash.util';

export interface DedupeCandidate {
  id: string;
  filename: string;
  sha256: string;
  phash: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  /**
   * Optional caller-supplied hint: candidates sharing the same non-empty
   * `groupKey` are treated as the same source image (e.g. the same design
   * re-exported at several scrape resolutions) and are always unioned
   * together, regardless of hash distance. A caller with no reliable
   * grouping hint can omit it and fall back to sha256 + perceptual hashing.
   */
  groupKey?: string;
}

export interface DedupeCluster {
  /** The candidate chosen to actually be imported for this cluster. */
  chosen: DedupeCandidate;
  /** Every candidate in the cluster, including `chosen`, in input order. */
  members: DedupeCandidate[];
  /** Why the cluster was formed. */
  reason: 'exact-duplicate' | 'same-source-group' | 'near-duplicate' | 'single';
}

export interface DedupeOptions {
  /**
   * Hamming-distance cutoff (out of a 256-bit dHash - see
   * DHASH_WIDTH/HEIGHT in image-hash.util.ts) below which two candidates
   * are unioned into the same cluster purely on perceptual similarity,
   * even with no shared `groupKey`/sha256. Pass a negative number to
   * disable perceptual auto-merging entirely (only exact sha256 and
   * `groupKey` matches cluster).
   *
   * Defaults to `NEAR_DUPLICATE_HAMMING_THRESHOLD`, which is safe for
   * generic use, but is NOT safe for every dataset - see the comment on
   * that constant. `scripts/catalog-import/run.ts` explicitly disables
   * this for the real `photos/` import after measuring that even a tight
   * threshold produced a false merge on this specific batch (three
   * different designs bridged together through noisy low-resolution
   * thumbnails - a real, reproduced failure, not a hypothetical one).
   */
  nearDuplicateHammingThreshold?: number;
}

// Conservative perceptual-similarity threshold out of a 256-bit dHash
// (see DHASH_WIDTH/HEIGHT in image-hash.util.ts). Safe as a *default* for
// a generic caller/tests.
//
// IMPORTANT, learned by measuring this project's actual `photos/` batch
// (not just synthetic fixtures): a naive global perceptual-hash threshold
// is NOT reliable on its own for this dataset. Every image shares the same
// mockup template (white background, identical phone-case silhouette and
// camera-cutout position), which dominates the hash. Worse, union-find
// merging means a single noisy pairwise match anywhere among hundreds of
// low-resolution/heavily-compressed thumbnails can transitively bridge two
// (or more) entirely different designs into one cluster - this was
// reproduced against the real data: three unrelated designs measured
// 10-12 bits apart at their best-quality representatives (comfortably
// above this threshold) but still got merged because a noisy pair of
// *thumbnails* from two of them landed under it. See `run.ts` for why the
// real import disables this mechanism and relies on `groupKey` (which
// tested 100% reliable across every one of this batch's 49 real designs)
// plus sha256 instead.
export const NEAR_DUPLICATE_HAMMING_THRESHOLD = 6;

/**
 * Groups candidates into clusters of duplicate/same-source images - union
 * of "same sha256", "same groupKey" (when provided), and (only if enabled -
 * see `DedupeOptions`) "dHash within the configured Hamming distance" -
 * then picks one winner per cluster: highest resolution, then largest file
 * size, then the cleanest filename. Pure function - no I/O - so it can be
 * unit tested with synthetic fixtures instead of real images.
 */
export function dedupeCandidates(
  candidates: DedupeCandidate[],
  options: DedupeOptions = {},
): DedupeCluster[] {
  const threshold = options.nearDuplicateHammingThreshold ?? NEAR_DUPLICATE_HAMMING_THRESHOLD;

  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootA] = rootB;
  };

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const sameHash = candidates[i].sha256 === candidates[j].sha256;
      const sameGroup =
        !!candidates[i].groupKey && candidates[i].groupKey === candidates[j].groupKey;
      const nearHash =
        !sameHash &&
        threshold >= 0 &&
        hammingDistance(candidates[i].phash, candidates[j].phash) <= threshold;
      if (sameHash || sameGroup || nearHash) union(i, j);
    }
  }

  const groups = new Map<number, DedupeCandidate[]>();
  candidates.forEach((candidate, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(candidate);
    groups.set(root, group);
  });

  return [...groups.values()].map((members) => ({
    chosen: pickBest(members),
    members,
    reason: classify(members),
  }));
}

export interface CrossClusterSimilarity {
  a: DedupeCandidate;
  b: DedupeCandidate;
  hammingDistance: number;
}

/**
 * Advisory-only check (never auto-merges): flags pairs of *different*
 * clusters' chosen representatives that still look perceptually close,
 * so a human can glance at them. Kept deliberately separate from
 * `dedupeCandidates` for the reason documented on `NEAR_DUPLICATE_HAMMING_THRESHOLD`.
 */
export function findCrossClusterSimilarities(
  clusters: DedupeCluster[],
  thresholdBits: number,
): CrossClusterSimilarity[] {
  const flagged: CrossClusterSimilarity[] = [];
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < clusters.length; j++) {
      const distance = hammingDistance(clusters[i].chosen.phash, clusters[j].chosen.phash);
      if (distance <= thresholdBits) {
        flagged.push({ a: clusters[i].chosen, b: clusters[j].chosen, hammingDistance: distance });
      }
    }
  }
  return flagged;
}

function classify(members: DedupeCandidate[]): DedupeCluster['reason'] {
  if (members.length === 1) return 'single';
  if (members.every((m) => m.sha256 === members[0].sha256)) return 'exact-duplicate';
  if (members[0].groupKey && members.every((m) => m.groupKey === members[0].groupKey)) {
    return 'same-source-group';
  }
  return 'near-duplicate';
}

function pickBest(members: DedupeCandidate[]): DedupeCandidate {
  return [...members].sort((a, b) => {
    const areaDiff = b.width * b.height - a.width * a.height;
    if (areaDiff !== 0) return areaDiff;
    const sizeDiff = b.fileSizeBytes - a.fileSizeBytes;
    if (sizeDiff !== 0) return sizeDiff;
    const cleanlinessDiff = filenameCleanliness(a.filename) - filenameCleanliness(b.filename);
    if (cleanlinessDiff !== 0) return cleanlinessDiff;
    return a.filename.localeCompare(b.filename);
  })[0];
}

// Lower score = cleaner. Penalizes long hex/uuid-like runs and raw digit
// counts, which is exactly what tells "MadridRoyaltyPhoneCase.jpg" (clean)
// apart from "d9369755-09ef-4045-b123-ac1c165d48c9copy5.jpg" (noisy).
function filenameCleanliness(filename: string): number {
  const base = filename.replace(/\.[^.]+$/, '');
  const hexRunLength = (base.match(/[0-9a-f]{6,}/gi) ?? []).join('').length;
  const digitCount = (base.match(/\d/g) ?? []).length;
  return hexRunLength * 2 + digitCount;
}
