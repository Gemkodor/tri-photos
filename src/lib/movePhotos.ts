import * as FileSystem from 'expo-file-system/legacy';
import { StorageAccessFramework } from 'expo-file-system/legacy';

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

function splitNameAndExtension(name: string): { base: string; mime: string } {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return { base: name, mime: 'application/octet-stream' };
  const extension = name.slice(dot + 1).toLowerCase();
  return { base: name.slice(0, dot), mime: MIME_TYPES[extension] ?? 'application/octet-stream' };
}

/**
 * Extracts a display name from a SAF document URI - same logic as
 * imageFiles.ts/trash.ts/albumExport.ts, duplicated locally to avoid a
 * circular import.
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
async function getOrCreateNamedFolder(parentUri: string, name: string): Promise<string> {
  const entries = await StorageAccessFramework.readDirectoryAsync(parentUri);
  for (const entryUri of entries) {
    if (getEntryDisplayName(entryUri) !== name) continue;
    try {
      await StorageAccessFramework.readDirectoryAsync(entryUri);
      return entryUri;
    } catch {
      // Same-named file, not a folder - keep looking / fall through to create below.
    }
  }
  return StorageAccessFramework.makeDirectoryAsync(parentUri, name);
}

/**
 * Moves each photo's bytes directly into `destFolderUri`, then deletes the
 * original document - a real reorganization (unlike the album's copy),
 * for when a photo turns out to be sitting in the wrong sub-folder. Each
 * photo is handled independently so one failure doesn't stop the rest.
 * Returns which ones actually moved (their old URI is now gone - the
 * caller needs to know exactly which, not just how many, to stop tracking
 * only those and leave any failure in place to retry).
 */
export async function movePhotosToFolder(
  photos: { uri: string; name: string }[],
  destFolderUri: string,
  onProgress?: (current: number, total: number) => void
): Promise<{ movedUris: string[]; failedCount: number }> {
  const movedUris: string[] = [];
  let failedCount = 0;
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    try {
      const { base, mime } = splitNameAndExtension(photo.name);
      const newFileUri = await StorageAccessFramework.createFileAsync(destFolderUri, base, mime);
      const content = await FileSystem.readAsStringAsync(photo.uri, { encoding: 'base64' });
      await FileSystem.writeAsStringAsync(newFileUri, content, { encoding: 'base64' });
      await FileSystem.deleteAsync(photo.uri, { idempotent: true });
      movedUris.push(photo.uri);
    } catch (error) {
      console.warn('Erreur déplacement photo', error);
      failedCount += 1;
    }
    onProgress?.(i + 1, photos.length);
  }
  return { movedUris, failedCount };
}

/** Same as `movePhotosToFolder`, but into a (created if needed) named sub-folder of `parentFolderUri`. */
export async function movePhotosToNewFolder(
  photos: { uri: string; name: string }[],
  parentFolderUri: string,
  folderName: string,
  onProgress?: (current: number, total: number) => void
): Promise<{ movedUris: string[]; failedCount: number }> {
  const destFolderUri = await getOrCreateNamedFolder(parentFolderUri, folderName);
  return movePhotosToFolder(photos, destFolderUri, onProgress);
}
