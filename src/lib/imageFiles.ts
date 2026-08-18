import { StorageAccessFramework } from 'expo-file-system/legacy';
import { SET_ASIDE_FOLDER_NAME } from './trash';

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
  'heif',
  'bmp',
  'gif',
]);

export type ImageFile = {
  /** SAF content:// URI of the file. */
  uri: string;
  /** Best-effort display file name, including extension. */
  name: string;
  /** Best-effort folder path the file lives in (e.g. "Pictures/Vacances"). */
  folderPath: string;
};

/**
 * Extracts a display name from a SAF document URI. SAF document IDs are the
 * last path segment (percent-encoded), e.g.
 * ".../document/primary%3APictures%2FIMG_001.jpg" -> "IMG_001.jpg".
 */
function getDisplayName(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const lastSegment = decoded.split('/').pop() ?? decoded;
    // Document IDs can look like "primary:Pictures/Vacances/IMG_001.jpg" once decoded.
    const afterColon = lastSegment.includes(':')
      ? lastSegment.slice(lastSegment.lastIndexOf(':') + 1)
      : lastSegment;
    return afterColon.split('/').pop() ?? afterColon;
  } catch {
    return uri;
  }
}

/**
 * Extracts the folder portion of a SAF document URI, e.g. for
 * ".../document/primary%3APictures%2FVacances%2FIMG_001.jpg" -> "Pictures/Vacances".
 * Best-effort: returns '' if the shape doesn't match what's expected.
 */
function getFolderPath(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const docMarker = '/document/';
    const idx = decoded.indexOf(docMarker);
    const afterDoc = idx === -1 ? decoded : decoded.slice(idx + docMarker.length);
    const afterColon = afterDoc.includes(':') ? afterDoc.slice(afterDoc.indexOf(':') + 1) : afterDoc;
    const parts = afterColon.split('/').filter(Boolean);
    parts.pop();
    return parts.join('/');
  } catch {
    return '';
  }
}

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(name));
}

/**
 * Opens the Android folder picker so the user can grant access to a folder
 * (and everything inside it, including sub-folders). Returns the granted
 * SAF directory URI, or null if the user cancelled.
 */
export async function pickFolder(initialUri?: string | null): Promise<string | null> {
  const result = await StorageAccessFramework.requestDirectoryPermissionsAsync(
    initialUri ?? undefined
  );
  if (!result.granted) return null;
  return result.directoryUri;
}

export type ScanProgress = {
  foundImages: number;
  scannedFolders: number;
};

/**
 * Recursively walks a SAF directory tree and collects every image file
 * found in it or any of its sub-folders.
 *
 * SAF's readDirectoryAsync doesn't tell us whether an entry is a file or a
 * folder, and getInfoAsync doesn't reliably report that for content:// URIs
 * either. So: entries whose name looks like an image are treated as files
 * directly (skipping a wasted lookup), and anything else is probed by
 * attempting to list it as a directory - if that throws, it's a file we
 * don't care about (video, doc, etc).
 */
export async function scanFolderForImages(
  rootUri: string,
  onProgress?: (progress: ScanProgress) => void
): Promise<ImageFile[]> {
  const images: ImageFile[] = [];
  let scannedFolders = 0;

  async function walk(dirUri: string, entries: string[]): Promise<void> {
    scannedFolders += 1;
    onProgress?.({ foundImages: images.length, scannedFolders });

    for (const entryUri of entries) {
      const name = getDisplayName(entryUri);
      if (isImageName(name)) {
        images.push({ uri: entryUri, name, folderPath: getFolderPath(entryUri) });
        onProgress?.({ foundImages: images.length, scannedFolders });
        continue;
      }
      // Never re-scan the app's own "De côté" folder - photos set aside in a
      // previous analysis would otherwise keep reappearing as "new" duplicates.
      if (name === SET_ASIDE_FOLDER_NAME) continue;

      // Not a recognizable image name: could be a sub-folder, could be some
      // other file type. Try to list it; only folders will succeed.
      try {
        const subEntries = await StorageAccessFramework.readDirectoryAsync(entryUri);
        await walk(entryUri, subEntries);
      } catch {
        // Not a folder we can read - skip it (unsupported file type).
      }
    }
  }

  const rootEntries = await StorageAccessFramework.readDirectoryAsync(rootUri);
  await walk(rootUri, rootEntries);
  return images;
}
