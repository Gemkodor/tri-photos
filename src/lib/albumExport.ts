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
 * imageFiles.ts/trash.ts, duplicated locally to avoid a circular import.
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

/**
 * Finds a direct child folder of `parentUri` named `name`, creating it if it
 * doesn't exist yet - so creating an album twice with the same name adds to
 * it instead of failing.
 */
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
 * Copies each photo's bytes into a (created if needed) sub-folder of
 * `parentFolderUri` named `folderName`. Always a copy, never a move - the
 * originals are read-only here, nothing is deleted or altered, so this can
 * never lose a photo the way moving could.
 */
export async function copyPhotosToNewFolder(
  photos: { uri: string; name: string }[],
  parentFolderUri: string,
  folderName: string,
  onProgress?: (current: number, total: number) => void
): Promise<{ copiedCount: number; failedCount: number }> {
  const destFolderUri = await getOrCreateNamedFolder(parentFolderUri, folderName);
  let copiedCount = 0;
  let failedCount = 0;
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    try {
      const { base, mime } = splitNameAndExtension(photo.name);
      const newFileUri = await StorageAccessFramework.createFileAsync(destFolderUri, base, mime);
      const content = await FileSystem.readAsStringAsync(photo.uri, { encoding: 'base64' });
      await FileSystem.writeAsStringAsync(newFileUri, content, { encoding: 'base64' });
      copiedCount += 1;
    } catch (error) {
      console.warn('Erreur copie album', error);
      failedCount += 1;
    }
    onProgress?.(i + 1, photos.length);
  }
  return { copiedCount, failedCount };
}
