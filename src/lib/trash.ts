import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { StorageAccessFramework } from 'expo-file-system/legacy';

const CORBEILLE_DIR = `${FileSystem.documentDirectory ?? ''}corbeille/`;
const MANIFEST_KEY = 'triPhotos.corbeilleManifest.v1';
/** Also used by imageFiles.ts to skip re-scanning this folder on future analyses. */
export const SET_ASIDE_FOLDER_NAME = 'De côté';
const SET_ASIDE_FOLDER_KEY_PREFIX = 'triPhotos.setAsideFolder.';

export type TrashEntry = {
  id: string;
  /** Local file:// URI where the photo now lives, inside the app's own storage. */
  uri: string;
  originalName: string;
  /** Folder the photo lived in before being jeté, e.g. "Pictures/Vacances" - used to restore it to the same place. */
  folderPath: string;
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
 * through the app's Corbeille screen until it's ranged into "De côté".
 */
export async function moveToTrash(photo: {
  uri: string;
  name: string;
  folderPath: string;
}): Promise<TrashEntry> {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const localUri = `${CORBEILLE_DIR}${id}_${photo.name}`;

  await StorageAccessFramework.moveAsync({ from: photo.uri, to: localUri });

  const entry: TrashEntry = {
    id,
    uri: localUri,
    originalName: photo.name,
    folderPath: photo.folderPath,
    movedAt: Date.now(),
  };
  const entries = await readManifest();
  entries.push(entry);
  await writeManifest(entries);
  return entry;
}

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  gif: 'image/gif',
};

function splitNameAndExtension(name: string): { base: string; extension: string; mime: string } {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return { base: name, extension: '', mime: 'application/octet-stream' };
  const extension = name.slice(dot + 1).toLowerCase();
  return {
    base: name.slice(0, dot),
    extension,
    mime: MIME_TYPES[extension] ?? 'application/octet-stream',
  };
}

/**
 * Extracts a display name from a SAF document URI - same logic as
 * imageFiles.ts, duplicated locally to avoid a circular import (imageFiles.ts
 * already imports SET_ASIDE_FOLDER_NAME from this file).
 */
function getEntryDisplayName(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const lastSegment = decoded.split('/').pop() ?? decoded;
    const afterColon = lastSegment.includes(':')
      ? lastSegment.slice(lastSegment.lastIndexOf(':') + 1)
      : lastSegment;
    return afterColon.split('/').pop() ?? afterColon;
  } catch {
    return uri;
  }
}

/** Finds a direct child folder of `parentUri` named `name`, creating it if it doesn't exist yet. */
async function getOrCreateChildFolder(parentUri: string, name: string): Promise<string> {
  const entries = await StorageAccessFramework.readDirectoryAsync(parentUri);
  for (const entryUri of entries) {
    if (getEntryDisplayName(entryUri) !== name) continue;
    try {
      // Confirm it's a folder (and not a file that happens to share the name) by listing it.
      await StorageAccessFramework.readDirectoryAsync(entryUri);
      return entryUri;
    } catch {
      // Same-named file, not a folder - keep looking / fall through to create below.
    }
  }
  return StorageAccessFramework.makeDirectoryAsync(parentUri, name);
}

/**
 * Walks (creating as needed) each segment of `folderPath` under `rootUri`,
 * e.g. "Pictures/Vacances" -> rootUri/Pictures/Vacances, so a restored photo
 * can land back in the same sub-folder it was jeté from.
 */
async function getOrCreateSubfolder(rootUri: string, folderPath: string): Promise<string> {
  if (!folderPath) return rootUri;
  let currentUri = rootUri;
  for (const segment of folderPath.split('/').filter(Boolean)) {
    currentUri = await getOrCreateChildFolder(currentUri, segment);
  }
  return currentUri;
}

/**
 * Finds (or creates) the "De côté" folder inside the user's granted folder
 * tree, and remembers it per-root so repeated set-asides reuse the same
 * folder instead of creating a new one each time.
 */
async function getSetAsideFolderUri(rootUri: string): Promise<string> {
  const cacheKey = `${SET_ASIDE_FOLDER_KEY_PREFIX}${rootUri}`;
  const cached = await AsyncStorage.getItem(cacheKey);
  if (cached) {
    try {
      await StorageAccessFramework.readDirectoryAsync(cached);
      return cached;
    } catch {
      // The cached folder no longer exists (e.g. deleted by the user) - recreate it below.
    }
  }
  const created = await StorageAccessFramework.makeDirectoryAsync(rootUri, SET_ASIDE_FOLDER_NAME);
  await AsyncStorage.setItem(cacheKey, created);
  return created;
}

/**
 * Moves one corbeille entry's bytes into a real, user-visible folder, then
 * removes the app-private copy. Never deletes the photo itself - worst case
 * it just sits in that folder.
 */
async function relocateEntryToFolder(entry: TrashEntry, folderUri: string): Promise<void> {
  const { base, mime } = splitNameAndExtension(entry.originalName);
  const newFileUri = await StorageAccessFramework.createFileAsync(folderUri, base, mime);
  const content = await FileSystem.readAsStringAsync(entry.uri, { encoding: 'base64' });
  await FileSystem.writeAsStringAsync(newFileUri, content, { encoding: 'base64' });
  await FileSystem.deleteAsync(entry.uri, { idempotent: true });
}

/**
 * Relocates corbeille entries using `resolveFolderUri` to decide each one's
 * destination (either the fixed "De côté" folder, or a restore's per-entry
 * original sub-folder). Entries that fail to move stay in the corbeille
 * rather than being dropped, so a partial failure never loses a photo.
 * `filterId` limits this to a single entry.
 */
async function relocateAll(
  resolveFolderUri: (entry: TrashEntry) => Promise<string>,
  filterId?: string
): Promise<{ movedCount: number }> {
  const entries = await readManifest();
  const toMove = filterId ? entries.filter((e) => e.id === filterId) : entries;
  const untouched = filterId ? entries.filter((e) => e.id !== filterId) : [];

  const remaining: TrashEntry[] = [...untouched];
  let movedCount = 0;
  for (const entry of toMove) {
    try {
      const folderUri = await resolveFolderUri(entry);
      await relocateEntryToFolder(entry, folderUri);
      movedCount += 1;
    } catch {
      remaining.push(entry);
    }
  }
  await writeManifest(remaining);
  return { movedCount };
}

/**
 * Moves a single corbeille photo into "De côté". Returns false (leaving the
 * entry in the corbeille) if the move failed, so nothing is ever silently lost.
 */
export async function moveOneToSetAside(entryId: string, rootUri: string): Promise<boolean> {
  const setAsideFolderUri = await getSetAsideFolderUri(rootUri);
  const { movedCount } = await relocateAll(async () => setAsideFolderUri, entryId);
  return movedCount > 0;
}

/** Moves every corbeille photo into "De côté". */
export async function moveAllToSetAside(rootUri: string): Promise<{ movedCount: number }> {
  const setAsideFolderUri = await getSetAsideFolderUri(rootUri);
  return relocateAll(async () => setAsideFolderUri);
}

/**
 * Puts a single corbeille photo back into the exact sub-folder it was jeté
 * from (recreating that sub-folder if it no longer exists).
 */
export async function restoreOne(entryId: string, rootUri: string): Promise<boolean> {
  const { movedCount } = await relocateAll(
    (entry) => getOrCreateSubfolder(rootUri, entry.folderPath),
    entryId
  );
  return movedCount > 0;
}

/**
 * Puts every corbeille photo back into its original sub-folder. Entries
 * sharing the same sub-folder reuse the same lookup instead of repeating it.
 */
export async function restoreAll(rootUri: string): Promise<{ movedCount: number }> {
  const folderCache = new Map<string, Promise<string>>();
  function resolve(entry: TrashEntry): Promise<string> {
    let cached = folderCache.get(entry.folderPath);
    if (!cached) {
      cached = getOrCreateSubfolder(rootUri, entry.folderPath);
      folderCache.set(entry.folderPath, cached);
    }
    return cached;
  }
  return relocateAll(resolve);
}

const REMINDER_MIN_COUNT = 5;
const REMINDER_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Photos in the corbeille still take up space on the phone until they're
 * ranged into "De côté" - this nudges the user once it's built up a bit and
 * sat there a while, rather than nagging as soon as a single photo lands in it.
 */
export function getTrashReminder(entries: TrashEntry[]): string | null {
  if (entries.length < REMINDER_MIN_COUNT) return null;
  const oldestMovedAt = Math.min(...entries.map((e) => e.movedAt));
  if (Date.now() - oldestMovedAt < REMINDER_MIN_AGE_MS) return null;
  return `${entries.length} photos attendent dans la corbeille depuis plus d'une semaine. Pense à les ranger dans "De côté" pour vraiment libérer de la place sur ton téléphone.`;
}

const LAST_FOLDER_KEY = 'triPhotos.lastFolderUri.v1';

export async function getLastFolderUri(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_FOLDER_KEY);
}

export async function setLastFolderUri(uri: string): Promise<void> {
  await AsyncStorage.setItem(LAST_FOLDER_KEY, uri);
}
