import { decode } from 'fast-png';

/**
 * All the pixel-level math previously done in a hidden WebView's <canvas>
 * (see HashWorker.tsx's history) - moved to plain JS so it survives Android
 * pausing that WebView's own JavaScript the moment the screen locks or the
 * app is backgrounded (a WebView-specific behavior a foreground service
 * can't prevent). Nothing here touches any View, GL surface, or native
 * module tied to the screen being visible - just decoding bytes already
 * produced by expo-image-manipulator (a native, non-WebView resize) and
 * doing arithmetic on the result, so it keeps running under the existing
 * foreground service the same way any other background JS work would.
 */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** No `atob`/Buffer assumed available - written out so this has zero platform dependency. */
export function base64ToUint8Array(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const byteLength = Math.floor((clean.length * 6) / 8);
  const bytes = new Uint8Array(byteLength);
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIndex = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = BASE64_CHARS.indexOf(clean[i]);
    if (value === -1) continue;
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[byteIndex++] = (bitBuffer >> bitCount) & 0xff;
    }
  }
  return bytes;
}

export type DecodedImage = {
  width: number;
  height: number;
  /** Grayscale, one value (0-255) per pixel, row-major - same weights as the old canvas code. */
  gray: Float64Array;
  /** 64 hex chars: a coarse RGB colour histogram (see computeColorSignature). Only for 3+ channel images. */
  colorSig?: string;
};

const HEX = '0123456789abcdef';

/** Decodes a base64 PNG (as produced by expo-image-manipulator) straight to a grayscale pixel array. */
export function decodePngToGrayscale(base64Png: string): DecodedImage {
  const bytes = base64ToUint8Array(base64Png);
  const png = decode(bytes);
  const { width, height, data, channels } = png;
  const gray = new Float64Array(width * height);
  const depthScale = png.depth === 16 ? 255 / 65535 : 1;
  const bins = channels >= 3 ? new Uint32Array(64) : null;
  for (let i = 0; i < width * height; i++) {
    const base = i * channels;
    if (channels >= 3) {
      const r = data[base] * depthScale;
      const g = data[base + 1] * depthScale;
      const b = data[base + 2] * depthScale;
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      // 4 levels per channel -> 64 colour bins
      (bins as Uint32Array)[((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)]++;
    } else {
      gray[i] = data[base] * depthScale;
    }
  }
  return { width, height, gray, colorSig: bins ? colorSignature(bins, width * height) : undefined };
}

/**
 * A photo's overall colour make-up as 64 hex characters (one 4-bit value per
 * colour bin: the square root of that bin's share of the image). The
 * shape-based hash can't tell that a close-up of a hand, a face and a full-
 * length shot of the same baby belong together - but they share the same
 * skin tones, clothes and room, and a colour histogram doesn't care how the
 * picture is framed. Comparing two of these (see colorSimilarity in
 * duplicateGroups.ts) is a cosine similarity of the square-rooted shares,
 * i.e. the Bhattacharyya coefficient.
 */
function colorSignature(bins: Uint32Array, pixelCount: number): string {
  let sig = '';
  for (let i = 0; i < 64; i++) {
    const v = Math.min(15, Math.round(Math.sqrt(bins[i] / pixelCount) * 15));
    sig += HEX[v];
  }
  return sig;
}

/**
 * Area-averaged downsample of a grayscale image to `dstW`x`dstH` - a plain-JS
 * stand-in for the smoothing a canvas drawImage() resize used to do for the
 * dHash, so the resulting bits stay as stable across recompression as before
 * (a naive nearest-neighbor pick would be noisier).
 */
export function downsampleGrayscale(
  image: DecodedImage,
  dstW: number,
  dstH: number
): Float64Array {
  const { width: srcW, height: srcH, gray } = image;
  const out = new Float64Array(dstW * dstH);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(srcH, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(srcW, Math.floor((x + 1) * xRatio)));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += gray[sy * srcW + sx];
          count++;
        }
      }
      out[y * dstW + x] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/**
 * Difference-hash (dHash) over a 17x16 grayscale grid - identical algorithm
 * to the previous canvas version, see duplicateGroups.ts's HASH_BITS (256)
 * doc comment for why this size was chosen.
 */
export function computeHashBits(hashGray: Float64Array): string {
  let bits = '';
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      bits += hashGray[y * 17 + x] < hashGray[y * 17 + x + 1] ? '1' : '0';
    }
  }
  return bits;
}

/**
 * Variance of the Laplacian restricted to a sub-rectangle - same blur-
 * detection math as before, optionally zoomed into a detected face's box.
 * Falls back to the whole image if the given rectangle is degenerate.
 */
export function computeSharpnessInRegion(
  image: DecodedImage,
  rx: number,
  ry: number,
  rw: number,
  rh: number
): number {
  const { width, height, gray } = image;
  let x0 = Math.max(1, rx);
  let y0 = Math.max(1, ry);
  let x1 = Math.min(width - 2, rx + rw);
  let y1 = Math.min(height - 2, ry + rh);
  if (x1 <= x0 || y1 <= y0) {
    x0 = 1;
    y0 = 1;
    x1 = width - 2;
    y1 = height - 2;
  }

  function g(px: number, py: number): number {
    return gray[py * width + px];
  }

  let mean = 0;
  let count = 0;
  const lap: number[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const value = g(x - 1, y) + g(x + 1, y) + g(x, y - 1) + g(x, y + 1) - 4 * g(x, y);
      lap.push(value);
      mean += value;
      count++;
    }
  }
  mean /= count;
  let variance = 0;
  for (const value of lap) {
    const d = value - mean;
    variance += d * d;
  }
  return variance / count;
}
