import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SortMode } from './duplicateGroups';
import type { HashedPhoto } from './perceptualHash';

const ANALYSIS_KEY = 'triPhotos.lastAnalysis.v1';

export type SavedAnalysis = {
  folderUri: string;
  similarityThreshold: number;
  hashedPhotos: HashedPhoto[];
  reviewedGroupKeys?: string[];
  mode?: SortMode;
};

export async function getSavedAnalysis(): Promise<SavedAnalysis | null> {
  const raw = await AsyncStorage.getItem(ANALYSIS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SavedAnalysis;
  } catch {
    return null;
  }
}

export async function saveAnalysis(analysis: SavedAnalysis): Promise<void> {
  await AsyncStorage.setItem(ANALYSIS_KEY, JSON.stringify(analysis));
}
