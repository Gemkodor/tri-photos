import type { HashedPhoto } from './perceptualHash';

/**
 * Preset similarity levels, from strict duplicates to a looser "these look
 * alike" grouping useful for a second, coarser sorting pass. Expressed as a
 * max Hamming distance out of 64 bits: lower = only near-identical copies,
 * higher = also groups photos that merely resemble each other.
 */
export const SIMILARITY_LEVELS = [
  {
    id: 'identical',
    label: 'Identiques',
    threshold: 4,
    description: 'Doublons stricts : la même photo, même si le fichier a changé.',
  },
  {
    id: 'close',
    label: 'Très proches',
    threshold: 10,
    description: 'Repère aussi les photos redimensionnées ou compressées différemment.',
  },
  {
    id: 'similar',
    label: 'Assez proches',
    threshold: 16,
    description: "Regroupe des photos qui se ressemblent sans être identiques - utile pour un second tri.",
  },
  {
    id: 'loose',
    label: 'Larges',
    threshold: 24,
    description: 'Regroupement très large : à utiliser pour dégrossir un gros tri.',
  },
] as const;

export type SimilarityLevelId = (typeof SIMILARITY_LEVELS)[number]['id'];

export const DEFAULT_SIMILARITY_THRESHOLD: number = SIMILARITY_LEVELS.find(
  (l) => l.id === 'close'
)!.threshold;

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
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD
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
