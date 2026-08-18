import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { HashWorkerHandle } from '../components/HashWorker';
import type { ImageFile } from './imageFiles';

export type HashedPhoto = {
  uri: string;
  name: string;
  /** Folder the file lives in, e.g. "Pictures/Vacances". */
  folderPath: string;
  /** Size in bytes of the file, used as a rough "which copy is better" hint. */
  sizeBytes: number | null;
  /** Original pixel dimensions, when available. */
  width: number | null;
  height: number | null;
  /** 64-bit dHash, as a string of '0'/'1' characters. */
  hash: string;
  /** Higher means sharper - only meaningful relative to other photos in the same group. */
  sharpness: number;
  /** True when sharpness was measured on a detected face rather than the whole photo. */
  facesFound: boolean;
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

    let width: number | null = null;
    let height: number | null = null;
    try {
      const original = await ImageManipulator.manipulate(localUri).renderAsync();
      width = original.width;
      height = original.height;
    } catch {
      // Keep width/height as null - not critical, just informational.
    }

    // Resized to 256x256 (not the final 9x8 hash size) so the worker still
    // has enough real detail left to judge sharpness - too small a source
    // and blur differences get smoothed away before they can be measured.
    // The worker itself shrinks this further for each purpose.
    const context = ImageManipulator.manipulate(localUri);
    const rendered = await context.resize({ width: 256, height: 256 }).renderAsync();
    const saved = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true });
    if (!saved.base64) return null;

    const { hash, sharpness, facesFound } = await worker.computeMetrics(saved.base64);
    return {
      uri: photo.uri,
      name: photo.name,
      folderPath: photo.folderPath,
      sizeBytes,
      width,
      height,
      hash,
      sharpness,
      facesFound,
    };
  } catch {
    return null;
  } finally {
    await FileSystem.deleteAsync(localUri, { idempotent: true });
  }
}
