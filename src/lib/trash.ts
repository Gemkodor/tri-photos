import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { StorageAccessFramework } from 'expo-file-system/legacy';

const CORBEILLE_DIR = `${FileSystem.documentDirectory ?? ''}corbeille/`;
const MANIFEST_KEY = 'triPhotos.corbeilleManifest.v1';

export type TrashEntry = {
  id: string;
  /** Local file:// URI where the photo now lives, inside the app's own storage. */
  uri: string;
  originalName: string;
  movedAt: number;
};

async function readManifest(): Promise<TrashEntry[]> {
  const raw = await AsyncStorage.getItem(MANIFEST_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as TrashEntry[];
  } catch {
    return [];
  }
}

async function writeManifest(entries: TrashEntry[]): Promise<void> {
  await AsyncStorage.setItem(MANIFEST_KEY, JSON.stringify(entries));
}

export async function getTrashEntries(): Promise<TrashEntry[]> {
  return readManifest();
}

/**
 * Moves a photo out of the user's chosen folder and into the app's private
 * "corbeille" storage. This is a real move (verified against the native SAF
 * implementation): the bytes are copied into app storage and only then is
 * the original document deleted, so the duplicate disappears from the
 * source folder but is never destroyed - it just becomes reachable only
 * through the app's Corbeille screen until permanently cleared.
 */
export async function moveToTrash(photo: { uri: string; name: string }): Promise<TrashEntry> {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const localUri = `${CORBEILLE_DIR}${id}_${photo.name}`;

  await StorageAccessFramework.moveAsync({ from: photo.uri, to: localUri });

  const entry: TrashEntry = { id, uri: localUri, originalName: photo.name, movedAt: Date.now() };
  const entries = await readManifest();
  entries.push(entry);
  await writeManifest(entries);
  return entry;
}

export async function permanentlyDelete(entryId: string): Promise<void> {
  const entries = await readManifest();
  const entry = entries.find((e) => e.id === entryId);
  if (entry) {
    await FileSystem.deleteAsync(entry.uri, { idempotent: true });
  }
  await writeManifest(entries.filter((e) => e.id !== entryId));
}

export async function emptyTrash(): Promise<void> {
  const entries = await readManifest();
  await Promise.all(entries.map((e) => FileSystem.deleteAsync(e.uri, { idempotent: true })));
  await writeManifest([]);
}

const LAST_FOLDER_KEY = 'triPhotos.lastFolderUri.v1';

export async function getLastFolderUri(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_FOLDER_KEY);
}

export async function setLastFolderUri(uri: string): Promise<void> {
  await AsyncStorage.setItem(LAST_FOLDER_KEY, uri);
}
