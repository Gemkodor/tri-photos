import type { HashedPhoto } from './perceptualHash';

/**
 * The app is several entirely separate parts, each with its own analysis -
 * on purpose: crossing between them used to silently trigger a second,
 * deeper re-analysis of the same folder, which was confusing. Now the only
 * way from one to the other is back through the home screen.
 *
 * Part "duplicates" is a single, deliberately minimal, fast pass that just
 * catches exact duplicates (fixed at 100% - no wiggle room, no face
 * detection) - useful on a big folder with lots of subfolders. Part
 * "sorting" is a second, deeper pass: "similar" groups photos from the same
 * shooting session (burst shots) and marks the blurry ones within each
 * group so both jobs happen at once, "blurry" is next with just the blurry
 * photos that didn't land in any group (nothing to compare them against
 * there, so they need their own pass), "decide" is a first pass over every
 * remaining photo where each one gets marked keep/later/trash, "later"
 * gathers just the ones marked "later" for a focused second look, "final"
 * is a last pass over every photo still in the folder, still marking blurry
 * ones, and "album" closes it out with a chance to pick photos for an
 * album. Part "moments" is a third, independent pass that groups every
 * photo purely by *when* it was taken (not what it looks like) - even a
 * single photo taken well apart from any other gets its own group of one -
 * with blur marked and the same keep/later/trash choice as "decide"; it then
 * gets its own "momentsLater" and "momentsFinal" wrap-up, mirroring
 * "later"/"final" from "sorting" (Flavie expected the same reassurance of a
 * last full pass after finishing the grouping, same as the other part
 * already had), before it too ends on "album". Part "quality" is a fourth,
 * independent pass with no grouping at all - just every photo in the folder
 * marked good or middling quality, to pick some to copy elsewhere.
 */
export type SortMode =
  | 'duplicates'
  | 'similar'
  | 'blurry'
  | 'decide'
  | 'later'
  | 'final'
  | 'moments'
  | 'momentsLater'
  | 'momentsFinal'
  | 'album'
  | 'quality';
export type SortPart = 'duplicates' | 'sorting' | 'moments' | 'quality';

export const SORT_STEP_ORDER: SortMode[] = [
  'duplicates',
  'similar',
  'blurry',
  'decide',
  'later',
  'final',
  'moments',
  'momentsLater',
  'momentsFinal',
  'album',
  'quality',
];
// Only these two are offered on the home screen now - the older "sorting"
// and "quality" parts are no longer reachable from there.
export const SORT_PART_ORDER: SortPart[] = ['duplicates', 'moments'];

export function partOf(mode: SortMode): SortPart {
  if (mode === 'duplicates') return 'duplicates';
  if (mode === 'moments' || mode === 'momentsLater' || mode === 'momentsFinal') return 'moments';
  if (mode === 'quality') return 'quality';
  return 'sorting';
}

/**
 * The steps belonging to the same part as `mode` - used for the step nav, so
 * it never offers a cross-part jump. "album" is reachable at the end of both
 * "sorting" and "moments" (via nextSortMode), but shown on its own once
 * there - it doesn't belong more to one than the other, and re-showing
 * either one's whole step list from inside "album" would be misleading.
 * "momentsLater"/"momentsFinal" reuse the exact same screens as
 * "later"/"final" (see ResultsScreen) but need their own SortMode values so
 * this step list stays "moments"'s own instead of borrowing "sorting"'s.
 */
export function partSteps(mode: SortMode): SortMode[] {
  if (mode === 'album') return ['album'];
  const part = partOf(mode);
  if (part === 'duplicates') return ['duplicates'];
  if (part === 'quality') return ['quality'];
  if (part === 'moments') return ['moments', 'momentsLater', 'momentsFinal', 'album'];
  return ['similar', 'blurry', 'decide', 'later', 'final', 'album'];
}

/**
 * A 16x16 dHash (256 bits) - see HashWorker.tsx's computeHashBits, which
 * must produce exactly this many bits. Originally 8x8 (64 bits), which
 * worked fine on a small folder but started coincidentally grouping
 * unrelated photos on a big one (hundreds of photos means tens of thousands
 * of pairs get compared, so even a small per-pair false-match chance turns
 * up real false positives - the "birthday paradox"). Four times the bits
 * makes a coincidental close match dramatically less likely, without having
 * to raise the similarity percentage itself.
 */
export const HASH_BITS = 256;

/**
 * The threshold is a max Hamming distance out of HASH_BITS: lower = only
 * near-identical copies, higher = also groups photos that merely resemble
 * each other. Capped at ~60% - validated by hand: past that point, groups
 * start pulling in photos that aren't really alike.
 */
export const SIMILARITY_THRESHOLD_MIN = 0;
export const SIMILARITY_THRESHOLD_MAX = Math.round((1 - 0.6) * HASH_BITS);
export const DEFAULT_SIMILARITY_THRESHOLD = Math.round((1 - 0.94) * HASH_BITS);

/** Converts a raw threshold into a "how similar" percentage for display. */
export function thresholdToPercent(threshold: number): number {
  return Math.round((1 - threshold / HASH_BITS) * 100);
}

export function percentToThreshold(percent: number): number {
  const raw = Math.round((1 - percent / 100) * HASH_BITS);
  return Math.min(SIMILARITY_THRESHOLD_MAX, Math.max(SIMILARITY_THRESHOLD_MIN, raw));
}

export const SORT_PARTS: Record<
  SortPart,
  { title: string; description: string; entryMode: SortMode }
> = {
  duplicates: {
    title: 'Recherche de doublons',
    description:
      "Repère les photos identiques ou qui se ressemblent, même dans plusieurs dossiers et même sur des milliers de photos (sans analyse de flou pour rester rapide). Tu règles la ressemblance avec un curseur, en commençant haut. Les photos de moins de 1 Mo sont bien repérées.",
    entryMode: 'duplicates',
  },
  sorting: {
    title: 'Tri des photos',
    description:
      "Regroupe les photos d'une même séance, repère les floues sans groupe, puis une dernière vérification de tout le dossier avant de terminer.",
    entryMode: 'similar',
  },
  moments: {
    title: 'Tri par moments',
    description:
      "Regroupe toutes les photos par moment (quand elles ont été prises). Tu peux réorganiser les moments et les photos, regrouper côte à côte les photos qui se ressemblent dans un moment, déplacer/copier vers d'autres dossiers, puis choisir tes favorites pour un album.",
    entryMode: 'moments',
  },
  quality: {
    title: 'Qualité des photos',
    description:
      "Analyse un dossier pour repérer les photos nettes et celles de qualité moyenne, sans les regrouper - pour choisir facilement lesquelles copier ailleurs (par exemple pour un album), sans toucher aux photos d'origine.",
    entryMode: 'quality',
  },
};

export const SORT_STEPS: Record<
  SortMode,
  { title: string; shortTitle: string; description: string; defaultThreshold: number }
> = {
  duplicates: {
    title: 'Doublons exacts',
    shortTitle: 'Doublons',
    description:
      'Repère les copies quasi parfaitement identiques de la même photo, pour un premier grand ménage rapide.',
    // Even a real copier-coller of the same file can decode to slightly
    // different pixels on this phone (rotation metadata read differently,
    // rounding during the resize pass...) - real-world testing showed two
    // copies of the same photo landing several bits apart. A wider
    // tolerance here still only catches "same photo" pairs (see
    // similarityDescription), never unrelated photos. Expressed as a
    // percent (not a raw bit count) so it keeps meaning the same ~91% no
    // matter how many bits HASH_BITS ends up being.
    defaultThreshold: percentToThreshold(91),
  },
  similar: {
    title: 'Photos similaires',
    shortTitle: 'Similaires',
    description:
      "Regroupe les photos prises à la suite (même scène, plusieurs essais), grise celles qui semblent floues, pour t'aider à ne garder que les meilleures.",
    // Flavie's preferred starting point - the slider still moves freely
    // from there.
    defaultThreshold: percentToThreshold(61),
  },
  blurry: {
    title: 'Photos floues sans groupe',
    shortTitle: 'Floues',
    description:
      "Les photos qui semblent floues mais n'ont pas de photo semblable à côté pour comparer - passe-les en revue une par une.",
    defaultThreshold: 0,
  },
  decide: {
    title: 'Garder, plus tard ou poubelle',
    shortTitle: 'Décider',
    description:
      "Marque chaque photo restante : à garder, à revoir plus tard, ou à la poubelle - pas besoin de trancher tout de suite pour celles qui hésitent.",
    defaultThreshold: 0,
  },
  later: {
    title: 'À revoir plus tard',
    shortTitle: 'Plus tard',
    description: "Juste les photos que tu as mises de côté pour y revenir - le moment d'en décider.",
    defaultThreshold: 0,
  },
  final: {
    title: 'Dernière vérification',
    shortTitle: 'Vérification',
    description:
      'Repasse en revue toutes les photos qui restent dans le dossier (les floues restent grisées), une dernière fois avant de terminer.',
    defaultThreshold: 0,
  },
  moments: {
    title: 'Tri par moments',
    shortTitle: 'Moments',
    description:
      "Regroupe toutes les photos par moment plutôt que par ressemblance - marque les floues, et choisis pour chacune : garder, plus tard, ou poubelle.",
    defaultThreshold: 0,
  },
  momentsLater: {
    title: 'À revoir plus tard',
    shortTitle: 'Plus tard',
    description: "Juste les photos que tu as mises de côté pour y revenir - le moment d'en décider.",
    defaultThreshold: 0,
  },
  momentsFinal: {
    title: 'Dernière vérification',
    shortTitle: 'Vérification',
    description:
      'Repasse en revue toutes les photos qui restent dans le dossier (les floues restent grisées), une dernière fois avant de choisir un album.',
    defaultThreshold: 0,
  },
  album: {
    title: 'Choisir un album',
    shortTitle: 'Album',
    description:
      "Choisis les photos que tu veux mettre dans un album, puis crée un nouveau dossier avec des copies - tes photos d'origine ne bougent pas.",
    defaultThreshold: 0,
  },
  quality: {
    title: 'Qualité des photos',
    shortTitle: 'Qualité',
    description:
      "Chaque photo est marquée si elle semble de qualité moyenne. Choisis celles à copier ailleurs.",
    defaultThreshold: 0,
  },
};

/** The next step within the same part, or null once at the end - used for "passer à l'étape suivante". Never crosses into the other part. */
export function nextSortMode(mode: SortMode): SortMode | null {
  const steps = partSteps(mode);
  const index = steps.indexOf(mode);
  return index >= 0 && index < steps.length - 1 ? steps[index + 1] : null;
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

/** Packs a HASH_BITS-char '0'/'1' string into uint32 words (32 bits each) for fast comparison. */
function packHash(hash: string): number[] {
  const words: number[] = [];
  for (let i = 0; i < hash.length; i += 32) {
    words.push(parseInt(hash.slice(i, i + 32), 2) >>> 0);
  }
  return words;
}

/**
 * Bit distance between two packed hashes. With `limit`, stops counting as
 * soon as the total exceeds it (returning that partial, over-limit total) -
 * on a folder of thousands of photos almost every pair is far apart, so
 * bailing after the first word or two instead of always summing all eight
 * makes the pairwise grouping several times faster.
 */
export function hammingDistance(a: number[], b: number[], limit: number = Infinity): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    total += popcount32(a[i] ^ b[i]);
    if (total > limit) return total;
  }
  return total;
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
      const distance = hammingDistance(packed[i], packed[j], best ? best.distance : Infinity);
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

/**
 * Whether every photo in the group lives in the same sub-folder. For exact
 * duplicates, this is what decides whether it's safe to trash any of them
 * without a second thought (same folder either way) or worth checking which
 * one to keep first (different folders - trashing the "wrong" one could
 * leave a sub-folder without any copy at all).
 */
export function groupIsSameFolder(group: DuplicateGroup): boolean {
  return group.photos.every((p) => p.folderPath === group.photos[0].folderPath);
}

/** A group's biggest photo is at least this many times its smallest to count as a "big" size gap (roughly a Mo-vs-Ko jump). */
const SIZE_DIFFERENCE_RATIO = 5;

/**
 * Whether the photos in this group span a big size gap (a few Mo next to a
 * few Ko) rather than being roughly the same size - a hint the "duplicates"
 * might not be as identical as the hash suggests (a resave, a thumbnail...),
 * worth reviewing more carefully than the straightforward same-size ones.
 */
export function groupHasLargeSizeDifference(group: DuplicateGroup): boolean {
  const sizes = group.photos.map((p) => p.sizeBytes ?? 0).filter((s) => s > 0);
  if (sizes.length < 2) return false;
  const smallest = Math.min(...sizes);
  const biggest = Math.max(...sizes);
  if (smallest <= 0) return false;
  return biggest / smallest >= SIZE_DIFFERENCE_RATIO;
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
 * Same-session safety net for the loose "similar" grouping (not used for
 * "duplicates", where a genuine copy can have a completely different
 * file-name timestamp than the original shot): two photos whose names both
 * parse to a timestamp further apart than this are extremely unlikely to be
 * the same shooting session, no matter how close their hash lands - this is
 * what a coincidental hash match between unrelated photos looks like (a
 * bath photo and an unrelated bathroom photo taken hours or days apart,
 * confirmed by Flavie). 30 minutes comfortably covers a real burst/session
 * without also swallowing "unrelated, but similarly lit/composed" photos
 * from a different moment entirely.
 */
export const SAME_SESSION_MAX_GAP_MS = 30 * 60 * 1000;

/**
 * Groups photos whose perceptual hashes are within `threshold` of each
 * other (transitively). Only groups with 2+ photos are returned. When
 * `maxTimeGapMs` is given, two photos are only ever linked if they're
 * hash-similar *and* (whenever both have a parseable file-name timestamp)
 * not further apart than that in time.
 */
export function groupDuplicates(
  photos: HashedPhoto[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  maxTimeGapMs?: number
): DuplicateGroup[] {
  const packed = photos.map((p) => packHash(p.hash));
  const uf = new UnionFind(photos.length);

  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      if (hammingDistance(packed[i], packed[j], threshold) > threshold) continue;
      if (maxTimeGapMs !== undefined) {
        const ta = photos[i].capturedAt;
        const tb = photos[j].capturedAt;
        if (ta !== null && tb !== null && Math.abs(ta - tb) > maxTimeGapMs) continue;
      }
      uf.union(i, j);
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

/** How close together (by file-name timestamp) photos need to be to count as the same "moment" - tighter than the "similar" safety net since this is meant to capture one specific burst of activity, not a whole loose session. */
export const MOMENT_GAP_MS = 10 * 60 * 1000;

/**
 * Groups every photo by *when* it was taken (see photoTimestamp.ts),
 * regardless of what it looks like - a "moment" is a run of photos whose
 * file-name timestamps are never more than `maxGapMs` apart from the next
 * one in time order. Unlike groupDuplicates, singleton groups are kept
 * (every photo lands in some moment, even one entirely on its own) and
 * photos with no parseable timestamp each get their own group, since
 * there's nothing to place them next to with any confidence.
 */
export function groupByMoments(photos: HashedPhoto[], maxGapMs: number): DuplicateGroup[] {
  const withTime = photos
    .filter((p) => p.capturedAt !== null)
    .sort((a, b) => (a.capturedAt as number) - (b.capturedAt as number));
  const withoutTime = photos.filter((p) => p.capturedAt === null);

  const groups: DuplicateGroup[] = [];
  let groupIndex = 0;

  // Undated photos first: there's nothing to place them next to with any
  // confidence, so each starts out alone - shown first specifically so
  // they're easy to check against the dated moments right below and
  // dragged in by hand if they really do belong to one (see
  // moveMomentPhoto in App.tsx).
  for (const photo of withoutTime) {
    groups.push({ id: `moment-${groupIndex++}`, photos: [photo] });
  }

  let current: HashedPhoto[] = [];
  function flush() {
    if (current.length === 0) return;
    current.sort(bestPhotoFirst);
    groups.push({ id: `moment-${groupIndex++}`, photos: current });
    current = [];
  }

  for (const photo of withTime) {
    const last = current[current.length - 1];
    if (last && (photo.capturedAt as number) - (last.capturedAt as number) > maxGapMs) {
      flush();
    }
    current.push(photo);
  }
  flush();

  return groups;
}

/** Cosine similarity (0-1) of two photos' colour signatures, or null if either lacks one. */
export function colorSimilarity(a: HashedPhoto, b: HashedPhoto): number | null {
  if (!a.colorSig || !b.colorSig) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.colorSig.length; i++) {
    const x = parseInt(a.colorSig[i], 16);
    const y = parseInt(b.colorSig[i], 16);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? null : dot / Math.sqrt(na * nb);
}

/**
 * Turns the "ressemblance" slider (60-100 %) into the minimum colour
 * similarity two photos need to be grouped by colour alone. Deliberately
 * strict at the top and loose at the bottom - within one moment (same place,
 * same light, minutes apart) two photos sharing a colour make-up are very
 * likely the same subject, but not so loose that everything merges.
 */
export function colorMinForPercent(percent: number): number {
  return 0.7 + 0.29 * (Math.min(100, Math.max(60, percent)) - 60) / 40;
}

/**
 * Groups `photos` (a single moment's, a few dozen at most) by resemblance,
 * keeping singletons - in first-appearance order, each cluster's photos in
 * their original order. Two photos count as resembling each other when
 * their shape hashes are within `threshold` bits (same framing, or a
 * near-copy) OR - when both have a colour signature and `colorMin` is given
 * - their colours match at least that well (same subject, different framing:
 * hand, face, full body...). Each photo joins the first earlier cluster
 * whose *first* photo it resembles, instead of chaining photo to photo,
 * which with colours would slowly glue a whole moment into one blob. It
 * never needs the pixels again, only what every photo already carries.
 */
export function clusterBySimilarity(
  photos: HashedPhoto[],
  threshold: number,
  colorMin?: number
): HashedPhoto[][] {
  const packed = photos.map((p) => packHash(p.hash));
  const clusters: { leader: number; photos: HashedPhoto[] }[] = [];
  photos.forEach((photo, i) => {
    let best: { cluster: (typeof clusters)[number]; score: number } | null = null;
    for (const cluster of clusters) {
      const leader = cluster.leader;
      const hashDistance = hammingDistance(packed[leader], packed[i], threshold);
      const hashClose = hashDistance <= threshold;
      const color = colorMin === undefined ? null : colorSimilarity(photos[leader], photo);
      const colorClose = color !== null && color >= colorMin!;
      if (!hashClose && !colorClose) continue;
      // Prefer the closest match when more than one cluster qualifies.
      const score = Math.max(hashClose ? 1 - hashDistance / HASH_BITS : 0, color ?? 0);
      if (!best || score > best.score) best = { cluster, score };
    }
    if (best) best.cluster.photos.push(photo);
    else clusters.push({ leader: i, photos: [photo] });
  });
  return clusters.map((c) => c.photos);
}

/** Same photos, reordered so each set of similar ones sits side by side (sets ordered by where their first photo already was). */
export function sortBySimilarity(
  photos: HashedPhoto[],
  threshold: number,
  colorMin?: number
): HashedPhoto[] {
  return ([] as HashedPhoto[]).concat(...clusterBySimilarity(photos, threshold, colorMin));
}

/**
 * Splits `photos` into one piece per set of 2+ similar photos, plus one
 * piece gathering every photo that resembles nothing else (rather than a
 * dozen one-photo pieces) - pieces ordered by where their first photo was.
 */
export function splitBySimilarity(
  photos: HashedPhoto[],
  threshold: number,
  colorMin?: number
): HashedPhoto[][] {
  const pieces: HashedPhoto[][] = [];
  let singlesIndex = -1;
  for (const cluster of clusterBySimilarity(photos, threshold, colorMin)) {
    if (cluster.length >= 2) {
      pieces.push(cluster);
    } else if (singlesIndex === -1) {
      singlesIndex = pieces.length;
      pieces.push([...cluster]);
    } else {
      pieces[singlesIndex].push(cluster[0]);
    }
  }
  return pieces;
}

/** Files under this size (1 Mo) are usually a low-quality copy someone sent over - worth spotting at a glance. */
export const LOW_QUALITY_MAX_BYTES = 1024 * 1024;

export function isLowQualitySize(photo: HashedPhoto): boolean {
  return photo.sizeBytes !== null && photo.sizeBytes < LOW_QUALITY_MAX_BYTES;
}

/** A photo is "clearly sharper" than another past this ratio of their sharpness scores. */
const SHARPNESS_RATIO_THRESHOLD = 1.4;

/**
 * Picks which photo in a group looks best, shown first with the star badge.
 * Sharpness wins when one photo is clearly sharper than the rest (catches a
 * blurry shot next to a sharp one); otherwise falls back to file size, which
 * is a decent proxy for resolution/quality when sharpness is a wash.
 */
// A sharpness score measured on just a face crop and one measured on a whole
// photo aren't on the same scale - a tight face crop naturally has less
// texture/edges than a full scene, even in perfect focus, so its Laplacian
// variance reads much lower. Comparing the two directly made faces look
// blurry next to sharp backgrounds and vice versa (confirmed by Flavie's
// own numbers: a 3160 "whole photo" reading judged sharper than a 1804
// "face" reading that actually looked sharper to her). Every sharpness
// comparison below only ever compares photos measured the same way.
function sameMeasurement(a: HashedPhoto, b: HashedPhoto): boolean {
  return a.facesFound === b.facesFound;
}

function bestPhotoFirst(a: HashedPhoto, b: HashedPhoto): number {
  const sharpA = a.sharpness || 0;
  const sharpB = b.sharpness || 0;
  const higher = Math.max(sharpA, sharpB);
  const lower = Math.min(sharpA, sharpB);
  if (sameMeasurement(a, b) && lower > 0 && higher / lower >= SHARPNESS_RATIO_THRESHOLD) {
    return sharpB - sharpA;
  }
  return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
}

/**
 * A photo is flagged as "blurry" when it's softer than the sharpest
 * same-measurement photo in its own group. Flavie found 1.15 (only 15%
 * softer than the group's best) too sensitive - a photo she didn't think
 * looked blurry at all was getting flagged just for being a bit behind a
 * sharper sibling. Loosened so only a clearer gap gets flagged.
 */
const BLUR_FLAG_RATIO = 1.3;

export function isBlurryInGroup(photo: HashedPhoto, group: DuplicateGroup): boolean {
  const comparable = group.photos.filter((p) => sameMeasurement(p, photo));
  const groupBestSharpness = Math.max(0, ...comparable.map((p) => p.sharpness || 0));
  const photoSharpness = photo.sharpness || 0;
  if (groupBestSharpness <= 0 || photoSharpness <= 0) return false;
  return groupBestSharpness / photoSharpness >= BLUR_FLAG_RATIO;
}

/** A photo is flagged blurry if it falls below this fraction of the scan's reference sharpness. */
const BLUR_BASELINE_RATIO = 0.7;

export type SharpnessBaseline = { whole: number; face: number };

/**
 * The reference sharpness for this batch of photos, used to flag photos with
 * no group to compare against - computed separately for face-measured and
 * whole-image-measured photos (see sameMeasurement above), since the two
 * aren't on the same scale. Uses the 80th percentile rather than the median
 * - the median is dragged down by ordinary variation in subject matter (a
 * plain sky is "softer" than a detailed scene even in perfect focus), so
 * comparing to "how sharp the average photo is" misses real blur. The 80th
 * percentile is a closer stand-in for "how sharp a good, in-focus photo from
 * this scan looks", which is the actual question being asked.
 */
export function computeSharpnessBaseline(photos: HashedPhoto[]): SharpnessBaseline {
  function percentile80(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8));
    return sorted[idx];
  }
  const whole = photos.filter((p) => !p.facesFound).map((p) => p.sharpness || 0).filter((s) => s > 0);
  const face = photos.filter((p) => p.facesFound).map((p) => p.sharpness || 0).filter((s) => s > 0);
  return { whole: percentile80(whole), face: percentile80(face) };
}

/**
 * Whole-scan blur check: flags a photo whether or not it belongs to a group,
 * by combining two signals - clearly softer than its own group's
 * same-measurement best (more sensitive, same-scene comparison), or clearly
 * softer than the scan's typical sharpness for its own measurement type
 * (catches a lone blurry photo with nothing similar to compare it against).
 *
 * Never flags the group's own star (its photos[0], the one the app itself
 * is suggesting to keep) - "this is the best one, also it's blurry" is a
 * contradiction that only undermines the recommendation (confirmed by
 * Flavie: a starred photo was being flagged blurry while sitting right next
 * to a photo that looked blurrier to her but wasn't flagged at all).
 */
export function isBlurryPhoto(
  photo: HashedPhoto,
  group: DuplicateGroup | null,
  sharpnessBaseline: SharpnessBaseline
): boolean {
  const photoSharpness = photo.sharpness || 0;
  if (photoSharpness <= 0) return false;
  if (group && group.photos[0] === photo) return false;
  if (group && isBlurryInGroup(photo, group)) return true;
  const baseline = photo.facesFound ? sharpnessBaseline.face : sharpnessBaseline.whole;
  if (baseline > 0 && photoSharpness < baseline * BLUR_BASELINE_RATIO) {
    return true;
  }
  return false;
}

/** Explains, for display, why the first photo in a group got the star. */
export function bestPhotoReason(group: DuplicateGroup): string {
  const [best, ...rest] = group.photos;
  const comparableRest = rest.filter((p) => sameMeasurement(p, best));
  const runnerUpSharpness = Math.max(0, ...comparableRest.map((p) => p.sharpness || 0));
  const bestSharpness = best.sharpness || 0;
  if (runnerUpSharpness > 0 && bestSharpness / runnerUpSharpness >= SHARPNESS_RATIO_THRESHOLD) {
    return best.facesFound
      ? "Suggérée : les visages sont plus nets sur cette version, les autres semblent flous."
      : "Suggérée : c'est la version la plus nette de ce groupe, les autres semblent floues.";
  }
  return "Suggérée : c'est le fichier le plus lourd du groupe, souvent signe de meilleure qualité.";
}
