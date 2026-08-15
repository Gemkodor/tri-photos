import type { HashedPhoto } from './perceptualHash';

/**
 * Below this Hamming distance (out of 64 bits), two photos are considered
 * the same shot. Tuned conservatively (tight) so that visually different
 * photos - like two shots from the same burst - don't get grouped together
 * and accidentally tempt a deletion; genuine re-compressed/resized copies
 * still land well under this threshold.
 */
export const DUPLICATE_DISTANCE_THRESHOLD = 8;

function popcount32(n: number): number {
  n = n - ((n >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  n = (n + (n >> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >> 24;
}

/** Packs a 64-char '0'/'1' string into two uint32s for fast comparison. */
function packHash(hash: string): [number, number] {
  return [parseInt(hash.slice(0, 32), 2) >>> 0, parseInt(hash.slice(32, 64), 2) >>> 0];
}

export function hammingDistance(a: [number, number], b: [number, number]): number {
  return popcount32(a[0] ^ b[0]) + popcount32(a[1] ^ b[1]);
}

export type DuplicateGroup = {
  id: string;
  photos: HashedPhoto[];
};

class UnionFind {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }

  union(a: number, b: number) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootA] = rootB;
  }
}

/**
 * Groups photos whose perceptual hashes are within DUPLICATE_DISTANCE_THRESHOLD
 * of each other (transitively). Only groups with 2+ photos are returned.
 */
export function groupDuplicates(
  photos: HashedPhoto[],
  threshold: number = DUPLICATE_DISTANCE_THRESHOLD
): DuplicateGroup[] {
  const packed = photos.map((p) => packHash(p.hash));
  const uf = new UnionFind(photos.length);

  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      if (hammingDistance(packed[i], packed[j]) <= threshold) {
        uf.union(i, j);
      }
    }
  }

  const buckets = new Map<number, HashedPhoto[]>();
  for (let i = 0; i < photos.length; i++) {
    const root = uf.find(i);
    const bucket = buckets.get(root);
    if (bucket) {
      bucket.push(photos[i]);
    } else {
      buckets.set(root, [photos[i]]);
    }
  }

  const groups: DuplicateGroup[] = [];
  for (const [root, group] of buckets) {
    if (group.length < 2) continue;
    // Largest file first: the likely "best quality" copy, shown first as a hint.
    group.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    groups.push({ id: `group-${root}`, photos: group });
  }
  return groups;
}
