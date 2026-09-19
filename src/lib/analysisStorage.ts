import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DuplicateGroup, SortMode } from './duplicateGroups';
import type { HashedPhoto } from './perceptualHash';

// v1 stored every photo in full (twice over for "moments": once in
// hashedPhotos, once more inside momentGroups) with each 256-bit hash as a
// 256-character '0'/'1' string - a few thousand photos could push a single
// AsyncStorage value past what Android will read back (roughly 2 MB),
// silently losing the whole saved analysis. v2 stores each hash as 64 hex
// characters and momentGroups as just lists of photo URIs (rebuilt from
// hashedPhotos on read). v1 is still read (once, if it's all there is) so
// an analysis saved before this change isn't lost.
const ANALYSIS_KEY_V1 = 'triPhotos.lastAnalysis.v1';
const ANALYSIS_KEY = 'triPhotos.lastAnalysis.v2';

export type SavedAnalysis = {
  folderUri: string;
  similarityThreshold: number;
  hashedPhotos: HashedPhoto[];
  reviewedGroupKeys?: string[];
  mode?: SortMode;
  /** "moments" only: the current grouping, including any hand-edits (moved photos) - unlike every other step's grouping, this one can't be recomputed from scratch without losing those. */
  momentGroups?: DuplicateGroup[];
};

type StoredAnalysis = Omit<SavedAnalysis, 'momentGroups'> & {
  momentGroups?: { id: string; uris: string[] }[];
};

function binaryToHex(bits: string): string {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16);
  }
  return hex;
}

function hexToBinary(hex: string): string {
  let bits = '';
  for (let i = 0; i < hex.length; i++) {
    bits += parseInt(hex[i], 16).toString(2).padStart(4, '0');
  }
  return bits;
}

/** Stored hex hashes are 64 chars; anything longer is already the full binary form (v1). */
function expandHash(hash: string): string {
  return hash.length <= 64 ? hexToBinary(hash) : hash;
}

function rebuild(stored: StoredAnalysis): SavedAnalysis {
  const hashedPhotos = stored.hashedPhotos.map((p) => ({ ...p, hash: expandHash(p.hash) }));
  const byUri = new Map(hashedPhotos.map((p) => [p.uri, p]));
  const momentGroups = stored.momentGroups
    ?.map((g) => ({
      id: g.id,
      photos: g.uris.map((uri) => byUri.get(uri)).filter((p): p is HashedPhoto => !!p),
    }))
    .filter((g) => g.photos.length > 0);
  return { ...stored, hashedPhotos, momentGroups };
}

export async function getSavedAnalysis(): Promise<SavedAnalysis | null> {
  try {
    const raw = await AsyncStorage.getItem(ANALYSIS_KEY);
    if (raw) return rebuild(JSON.parse(raw) as StoredAnalysis);
    const legacy = await AsyncStorage.getItem(ANALYSIS_KEY_V1);
    if (!legacy) return null;
    const parsed = JSON.parse(legacy) as SavedAnalysis;
    return {
      ...parsed,
      hashedPhotos: parsed.hashedPhotos.map((p) => ({ ...p, hash: expandHash(p.hash) })),
    };
  } catch (error) {
    // Too big to read back, or corrupted - the app just starts fresh rather
    // than failing to open.
    console.warn('Analyse sauvegardée illisible', error);
    return null;
  }
}

export async function saveAnalysis(analysis: SavedAnalysis): Promise<void> {
  try {
    const stored: StoredAnalysis = {
      ...analysis,
      hashedPhotos: analysis.hashedPhotos.map((p) => ({ ...p, hash: binaryToHex(p.hash) })),
      momentGroups: analysis.momentGroups?.map((g) => ({
        id: g.id,
        uris: g.photos.map((p) => p.uri),
      })),
    };
    await AsyncStorage.setItem(ANALYSIS_KEY, JSON.stringify(stored));
    // The old, much bigger copy is no longer needed once a v2 exists.
    await AsyncStorage.removeItem(ANALYSIS_KEY_V1);
  } catch (error) {
    console.warn('Sauvegarde de l’analyse impossible', error);
  }
}

const FAVORITES_KEY = 'triPhotos.favorites.v1';

/** Photos marked ♥ favorite, kept separately so they survive closing the app without touching the (much bigger) analysis record. */
export async function getSavedFavorites(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(FAVORITES_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export async function saveFavorites(uris: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(uris));
  } catch (error) {
    console.warn('Sauvegarde des favoris impossible', error);
  }
}
