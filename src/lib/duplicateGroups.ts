import type { HashedPhoto } from './perceptualHash';

/**
 * The sorting path: step 1 is its own, separate, deliberately simple pass
 * that just catches exact duplicates (fixed at 100% - no wiggle room, no
 * face detection - the fastest possible check, since it's often run first
 * on a big folder with lots of subfolders). Step 2 is a second, deeper pass
 * that groups photos from the same shooting session (burst shots) and marks
 * the blurry ones within each group so both jobs happen at once. Step 3 is
 * a final pass over every photo still in the folder before wrapping up,
 * still marking blurry ones.
 */
export type SortMode = 'duplicates' | 'similar' | 'final';

export const SORT_STEP_ORDER: SortMode[] = ['duplicates', 'similar', 'final'];

export const SORT_STEPS: Record<
  SortMode,
  { title: string; shortTitle: string; description: string; defaultThreshold: number }
> = {
  duplicates: {
    title: 'Étape 1 · Doublons exacts',
    shortTitle: 'Étape 1',
    description:
      'Repère les copies quasi parfaitement identiques de la même photo, pour un premier grand ménage rapide.',
    // Even a real copier-coller of the same file can decode to slightly
    // different pixels on this phone (rotation metadata read differently,
    // rounding during the resize pass...) - real-world testing showed two
    // copies of the same photo landing several bits apart. A wider
    // tolerance here still only catches "same photo" pairs (see
    // similarityDescription), never unrelated photos.
    defaultThreshold: 6,
  },
  similar: {
    title: 'Étape 2 · Photos similaires',
    shortTitle: 'Étape 2',
    description:
      "Regroupe les photos prises à la suite (même scène, plusieurs essais), grise celles qui semblent floues, pour t'aider à ne garder que les meilleures.",
    defaultThreshold: 12,
  },
  final: {
    title: 'Étape 3 · Dernière vérification',
    shortTitle: 'Étape 3',
    description:
      'Repasse en revue toutes les photos qui restent dans le dossier (les floues restent grisées), une dernière fois avant de terminer.',
    defaultThreshold: 0,
  },
};

/** The next step in the path, or null once at the end - used for "passer à l'étape suivante". */
export function nextSortMode(mode: SortMode): SortMode | null {
  const index = SORT_STEP_ORDER.indexOf(mode);
  return index >= 0 && index < SORT_STEP_ORDER.length - 1 ? SORT_STEP_ORDER[index + 1] : null;
}

/**
 * The threshold is a max Hamming distance out of 64 hash bits: lower = only
 * near-identical copies, higher = also groups photos that merely resemble
 * each other. Capped at 26 (60%) - validated by hand: past that point,
 * groups start pulling in photos that aren't really alike.
 */
export const SIMILARITY_THRESHOLD_MIN = 0;
export const SIMILARITY_THRESHOLD_MAX = 26;
export const DEFAULT_SIMILARITY_THRESHOLD = 4;

/** Converts a raw threshold into a "how similar" percentage for display. */
export function thresholdToPercent(threshold: number): number {
  return Math.round((1 - threshold / 64) * 100);
}

export function percentToThreshold(percent: number): number {
  const raw = Math.round((1 - percent / 100) * 64);
  return Math.min(SIMILARITY_THRESHOLD_MAX, Math.max(SIMILARITY_THRESHOLD_MIN, raw));
}

export function similarityDescription(threshold: number): string {
  const percent = thresholdToPercent(threshold);
  if (percent >= 97) {
    return 'Doublons stricts : exactement la même photo, même si le fichier a changé.';
  }
  if (percent >= 90) {
    return 'Repère aussi les photos redimensionnées ou compressées différemment.';
  }
  if (percent >= 80) {
    return "Regroupe des photos qui se ressemblent sans être identiques - utile pour un second tri.";
  }
  if (percent >= 70) {
    return 'Regroupement large : peut réunir des photos qui ne sont pas vraiment des doublons. Vérifie bien chaque groupe avant de jeter.';
  }
  return 'Regroupement très large : à ce niveau, des photos sans rapport peuvent se retrouver ensemble. Vérifie bien chaque groupe avant de jeter.';
}

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

export type ClosestPair = { a: HashedPhoto; b: HashedPhoto; distance: number };

/**
 * Finds the two photos in the whole set whose hashes are the closest match,
 * regardless of any threshold. Used to show "how close is close" when no
 * duplicate group meets the current threshold - a concrete number to check
 * against instead of guessing blindly at why a pair wasn't grouped.
 */
export function findClosestPair(photos: HashedPhoto[]): ClosestPair | null {
  if (photos.length < 2) return null;
  const packed = photos.map((p) => packHash(p.hash));
  let best: ClosestPair | null = null;
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      const distance = hammingDistance(packed[i], packed[j]);
      if (!best || distance < best.distance) {
        best = { a: photos[i], b: photos[j], distance };
      }
    }
  }
  return best;
}

export type DuplicateGroup = {
  id: string;
  photos: HashedPhoto[];
};

/**
 * A stable identity for a group based on its actual photos, unlike `id`
 * (which is derived from array positions and shifts whenever the photo list
 * or threshold changes). Used to remember which groups the user already
 * reviewed across re-renders and app restarts.
 */
export function groupKey(group: DuplicateGroup): string {
  return group.photos
    .map((p) => p.uri)
    .slice()
    .sort()
    .join('|');
}

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
    group.sort(bestPhotoFirst);
    groups.push({ id: `group-${root}`, photos: group });
  }
  return groups;
}

/** A photo is "clearly sharper" than another past this ratio of their sharpness scores. */
const SHARPNESS_RATIO_THRESHOLD = 1.4;

/**
 * Picks which photo in a group looks best, shown first with the star badge.
 * Sharpness wins when one photo is clearly sharper than the rest (catches a
 * blurry shot next to a sharp one); otherwise falls back to file size, which
 * is a decent proxy for resolution/quality when sharpness is a wash.
 */
function bestPhotoFirst(a: HashedPhoto, b: HashedPhoto): number {
  const sharpA = a.sharpness || 0;
  const sharpB = b.sharpness || 0;
  const higher = Math.max(sharpA, sharpB);
  const lower = Math.min(sharpA, sharpB);
  if (lower > 0 && higher / lower >= SHARPNESS_RATIO_THRESHOLD) {
    return sharpB - sharpA;
  }
  return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
}

/**
 * A photo is flagged as "blurry" when it's softer than the sharpest photo in
 * its own group. This uses a more sensitive ratio than the star pick - we'd
 * rather flag a borderline photo for the user to glance at than miss a real
 * one, whereas the star should only move for a clear-cut winner.
 */
const BLUR_FLAG_RATIO = 1.15;

export function isBlurryInGroup(photo: HashedPhoto, group: DuplicateGroup): boolean {
  const groupBestSharpness = Math.max(0, ...group.photos.map((p) => p.sharpness || 0));
  const photoSharpness = photo.sharpness || 0;
  if (groupBestSharpness <= 0 || photoSharpness <= 0) return false;
  return groupBestSharpness / photoSharpness >= BLUR_FLAG_RATIO;
}

/** A photo is flagged blurry if it falls below this fraction of the scan's reference sharpness. */
const BLUR_BASELINE_RATIO = 0.7;

/**
 * The reference sharpness for this batch of photos, used to flag photos with
 * no group to compare against. Uses the 80th percentile rather than the
 * median - the median is dragged down by ordinary variation in subject
 * matter (a plain sky is "softer" than a detailed scene even in perfect
 * focus), so comparing to "how sharp the average photo is" misses real blur.
 * The 80th percentile is a closer stand-in for "how sharp a good, in-focus
 * photo from this scan looks", which is the actual question being asked.
 */
export function computeSharpnessBaseline(photos: HashedPhoto[]): number {
  const values = photos.map((p) => p.sharpness || 0).filter((s) => s > 0);
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const idx = Math.min(values.length - 1, Math.floor(values.length * 0.8));
  return values[idx];
}

/**
 * Whole-scan blur check: flags a photo whether or not it belongs to a group,
 * by combining two signals - clearly softer than its own group's best (more
 * sensitive, same-scene comparison), or clearly softer than the scan's
 * typical sharpness (catches a lone blurry photo with nothing similar to
 * compare it against).
 */
export function isBlurryPhoto(
  photo: HashedPhoto,
  group: DuplicateGroup | null,
  sharpnessBaseline: number
): boolean {
  const photoSharpness = photo.sharpness || 0;
  if (photoSharpness <= 0) return false;
  if (group && isBlurryInGroup(photo, group)) return true;
  if (sharpnessBaseline > 0 && photoSharpness < sharpnessBaseline * BLUR_BASELINE_RATIO) {
    return true;
  }
  return false;
}

/** Explains, for display, why the first photo in a group got the star. */
export function bestPhotoReason(group: DuplicateGroup): string {
  const [best, ...rest] = group.photos;
  const runnerUpSharpness = Math.max(0, ...rest.map((p) => p.sharpness || 0));
  const bestSharpness = best.sharpness || 0;
  if (runnerUpSharpness > 0 && bestSharpness / runnerUpSharpness >= SHARPNESS_RATIO_THRESHOLD) {
    return best.facesFound
      ? "Suggérée : les visages sont plus nets sur cette version, les autres semblent flous."
      : "Suggérée : c'est la version la plus nette de ce groupe, les autres semblent floues.";
  }
  return "Suggérée : c'est le fichier le plus lourd du groupe, souvent signe de meilleure qualité.";
}
