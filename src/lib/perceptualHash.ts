import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { HashWorkerHandle } from '../components/HashWorker';
import type { ImageFile } from './imageFiles';

export type HashedPhoto = {
  uri: string;
  name: string;
  /** Size in bytes of the file, used as a rough "which copy is better" hint. */
  sizeBytes: number | null;
  /** 64-bit dHash, as a string of '0'/'1' characters. */
  hash: string;
};

const TEMP_DIR = (FileSystem.cacheDirectory ?? '') + 'tri-photos-tmp/';

async function ensureTempDir() {
  const info = await FileSystem.getInfoAsync(TEMP_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(TEMP_DIR, { intermediates: true });
  }
}

/**
 * Copies a SAF photo locally, computes its dHash via the WebView worker, and
 * cleans up the local temp copy - regardless of any photo's file being huge,
 * only a tiny 9x8 thumbnail ever crosses into JS.
 */
export async function hashPhoto(
  photo: ImageFile,
  worker: HashWorkerHandle
): Promise<HashedPhoto | null> {
  await ensureTempDir();
  const localUri = `${TEMP_DIR}${Date.now()}_${Math.random().toString(36).slice(2)}`;

  try {
    await FileSystem.copyAsync({ from: photo.uri, to: localUri });

    let sizeBytes: number | null = null;
    try {
      const info = await FileSystem.getInfoAsync(localUri);
      sizeBytes = info.exists ? (info.size ?? null) : null;
    } catch {
      sizeBytes = null;
    }

    const context = ImageManipulator.manipulate(localUri);
    const rendered = await context.resize({ width: 9, height: 8 }).renderAsync();
    const saved = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true });
    if (!saved.base64) return null;

    const hash = await worker.computeHash(saved.base64);
    return { uri: photo.uri, name: photo.name, sizeBytes, hash };
  } catch {
    return null;
  } finally {
    await FileSystem.deleteAsync(localUri, { idempotent: true });
  }
}
