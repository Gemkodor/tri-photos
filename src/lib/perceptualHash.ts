import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { HashWorkerHandle } from '../components/HashWorker';
import type { ImageFile } from './imageFiles';
import { extractTimestampFromName } from './photoTimestamp';

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
  /** 256-bit dHash, as a string of '0'/'1' characters. */
  hash: string;
  /** Higher means sharper - only meaningful relative to other photos in the same group. */
  sharpness: number;
  /** True when sharpness was measured on a detected face rather than the whole photo. */
  facesFound: boolean;
  /** Best-effort "when taken" guess (epoch ms) parsed from the file name, or null - see photoTimestamp.ts. */
  capturedAt: number | null;
};

const TEMP_DIR = (FileSystem.cacheDirectory ?? '') + 'tri-photos-tmp/';

async function ensureTempDir() {
  const info = await FileSystem.getInfoAsync(TEMP_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(TEMP_DIR, { intermediates: true });
  }
}

export type HashPhotoResult = { photo: HashedPhoto | null; error: string | null };

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Copies a SAF photo locally, computes its dHash via the WebView worker, and
 * cleans up the local temp copy - regardless of any photo's file being huge,
 * only a tiny 9x8 thumbnail ever crosses into JS.
 *
 * Returns the failure reason alongside a null photo (rather than silently
 * swallowing it) so a total analysis failure can show *why* instead of just
 * "0 photos" with no way to tell what actually went wrong.
 */
export async function hashPhoto(
  photo: ImageFile,
  worker: HashWorkerHandle,
  options?: { needSharpness?: boolean }
): Promise<HashPhotoResult> {
  const needSharpness = options?.needSharpness ?? true;
  await ensureTempDir();
  const localUri = `${TEMP_DIR}${Date.now()}_${Math.random().toString(36).slice(2)}`;

  try {
    try {
      await FileSystem.copyAsync({ from: photo.uri, to: localUri });
    } catch (e) {
      return { photo: null, error: `copie du fichier : ${describeError(e)}` };
    }

    let sizeBytes: number | null = null;
    try {
      const info = await FileSystem.getInfoAsync(localUri);
      sizeBytes = info.exists ? (info.size ?? null) : null;
    } catch {
      sizeBytes = null;
    }

    let width: number | null = null;
    let height: number | null = null;
    // Skipped for the duplicates-only pass - purely informational, not
    // needed to compare photos, and the fastest possible check skips
    // whatever it can.
    if (needSharpness) {
      try {
        const original = await ImageManipulator.manipulate(localUri).renderAsync();
        width = original.width;
        height = original.height;
      } catch {
        // Keep width/height as null - not critical, just informational.
      }
    }

    // Resized to 256x256 (not the final 9x8 hash size) so the worker still
    // has enough real detail left to judge sharpness - too small a source
    // and blur differences get smoothed away before they can be measured.
    // The worker itself shrinks this further for each purpose. When
    // sharpness isn't needed at all (duplicates pass), a much smaller
    // resize is plenty for the 9x8 hash and is faster to produce and send.
    let base64: string | undefined;
    try {
      const size = needSharpness ? 256 : 32;
      const context = ImageManipulator.manipulate(localUri);
      const rendered = await context.resize({ width: size, height: size }).renderAsync();
      const saved = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true });
      base64 = saved.base64;
    } catch (e) {
      return { photo: null, error: `redimensionnement : ${describeError(e)}` };
    }
    if (!base64) return { photo: null, error: 'redimensionnement : pas de résultat' };

    let metrics;
    try {
      metrics = await worker.computeMetrics(base64, { needSharpness });
    } catch (e) {
      return { photo: null, error: `analyse visuelle : ${describeError(e)}` };
    }

    return {
      photo: {
        uri: photo.uri,
        name: photo.name,
        folderPath: photo.folderPath,
        sizeBytes,
        width,
        height,
        hash: metrics.hash,
        sharpness: metrics.sharpness,
        facesFound: metrics.facesFound,
        capturedAt: extractTimestampFromName(photo.name),
      },
      error: null,
    };
  } catch (e) {
    return { photo: null, error: describeError(e) };
  } finally {
    await FileSystem.deleteAsync(localUri, { idempotent: true });
  }
}
