import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { FACE_DETECT_SIZE, type HashWorkerHandle } from '../components/HashWorker';
import type { ImageFile } from './imageFiles';
import { extractTimestampFromName } from './photoTimestamp';
import {
  computeHashBits,
  computeSharpnessInRegion,
  decodePngToGrayscale,
  downsampleGrayscale,
} from './pixelAnalysis';

/** Plain hash grid size (17x16 -> 256 dHash bits, see duplicateGroups.ts's HASH_BITS). */
const HASH_GRID_WIDTH = 17;
const HASH_GRID_HEIGHT = 16;

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
  /** Coarse colour histogram (see pixelAnalysis.ts) - lets similar-looking photos with different framing be grouped. Missing on analyses from before it existed. */
  colorSig?: string;
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
 * Copies a SAF photo locally, computes its dHash/sharpness (plain JS, see
 * pixelAnalysis.ts) and, when needed, its face region (the `worker`, still
 * WebView-based - see HashWorker.tsx), then cleans up the local temp copy -
 * regardless of any photo's file being huge, only a small resized render
 * ever gets decoded.
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

    // The duplicates-only pass resizes straight to the final 17x16 hash
    // grid - a native resize (expo-image-manipulator), not a WebView, so
    // this is as fast a path as there is. When sharpness is needed too, a
    // single bigger 220x220 render is decoded once and reused both for the
    // hash (downsampled in plain JS below) and for measuring blur - real
    // detail would get smoothed away by resizing straight to 17x16 first.
    let metrics: { hash: string; sharpness: number; facesFound: boolean; colorSig?: string };
    try {
      if (!needSharpness) {
        const rendered = await ImageManipulator.manipulate(localUri)
          .resize({ width: HASH_GRID_WIDTH, height: HASH_GRID_HEIGHT })
          .renderAsync();
        const saved = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true });
        if (!saved.base64) return { photo: null, error: 'redimensionnement : pas de résultat' };
        const decoded = decodePngToGrayscale(saved.base64);
        metrics = { hash: computeHashBits(decoded.gray), sharpness: 0, facesFound: false };
      } else {
        const rendered = await ImageManipulator.manipulate(localUri)
          .resize({ width: FACE_DETECT_SIZE, height: FACE_DETECT_SIZE })
          .renderAsync();
        const saved = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true });
        if (!saved.base64) return { photo: null, error: 'redimensionnement : pas de résultat' };
        const decoded = decodePngToGrayscale(saved.base64);
        const hashGray = downsampleGrayscale(decoded, HASH_GRID_WIDTH, HASH_GRID_HEIGHT);
        const hash = computeHashBits(hashGray);

        // Never rejects/hangs (see HashWorker.detectFace) - a photo processed
        // while the app is backgrounded just falls back to whole-image
        // sharpness below, same as a photo with no detectable face.
        const faceRegion = await worker.detectFace(saved.base64);
        const sharpness = faceRegion
          ? computeSharpnessInRegion(decoded, faceRegion.x, faceRegion.y, faceRegion.w, faceRegion.h)
          : computeSharpnessInRegion(decoded, 0, 0, decoded.width, decoded.height);
        metrics = { hash, sharpness, facesFound: !!faceRegion, colorSig: decoded.colorSig };
      }
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
        colorSig: metrics.colorSig,
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
