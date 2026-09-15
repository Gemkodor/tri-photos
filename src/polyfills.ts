/**
 * Must be imported first, before anything else (see index.ts) - it patches
 * a global that other modules construct at their own import time, so it
 * has to already be in place before those imports run.
 *
 * fast-png (see pixelAnalysis.ts) creates a `new TextDecoder('latin1')` at
 * module load time (PNG text chunks are Latin-1 by spec) - Hermes's
 * TextDecoder only recognizes 'utf-8' and throws `RangeError: Unknown
 * encoding` for anything else, which crashed the app on startup before it
 * ever got to render anything, since that import happens just by requiring
 * fast-png, regardless of whether a PNG with text chunks is ever decoded.
 *
 * Latin-1 maps every byte 0-255 directly to the same-numbered code point,
 * so decoding it needs no real charset table - this wraps the real
 * TextDecoder, only intercepting the label it doesn't understand.
 */
const LATIN1_LABELS = new Set([
  'latin1',
  'iso-8859-1',
  'iso8859-1',
  'l1',
  'cp819',
  'csisolatin1',
  '819',
  'us-ascii',
  'ascii',
]);

function patchTextDecoderForLatin1() {
  const globalObject = globalThis as unknown as { TextDecoder?: typeof TextDecoder };
  const maybeOriginalTextDecoder = globalObject.TextDecoder;
  if (!maybeOriginalTextDecoder) return;
  // Already patched (e.g. Fast Refresh re-running this module) - don't wrap twice.
  if ((maybeOriginalTextDecoder as unknown as { __latin1Patched?: boolean }).__latin1Patched) return;
  const OriginalTextDecoder = maybeOriginalTextDecoder;

  class PatchedTextDecoder {
    private readonly isLatin1: boolean;
    private readonly inner: TextDecoder | null;

    constructor(label?: string, options?: TextDecoderOptions) {
      const normalized = (label ?? 'utf-8').toLowerCase();
      if (LATIN1_LABELS.has(normalized)) {
        this.isLatin1 = true;
        this.inner = null;
      } else {
        this.isLatin1 = false;
        this.inner = new OriginalTextDecoder(label, options);
      }
    }

    get encoding(): string {
      return this.isLatin1 ? 'iso-8859-1' : (this.inner as TextDecoder).encoding;
    }

    get fatal(): boolean {
      return this.isLatin1 ? false : (this.inner as TextDecoder).fatal;
    }

    get ignoreBOM(): boolean {
      return this.isLatin1 ? false : (this.inner as TextDecoder).ignoreBOM;
    }

    decode(input?: ArrayBufferView | ArrayBuffer, options?: TextDecodeOptions): string {
      if (!this.isLatin1) return (this.inner as TextDecoder).decode(input, options);
      if (!input) return '';
      const bytes =
        input instanceof Uint8Array
          ? input
          : new Uint8Array('buffer' in input ? input.buffer : input);
      // In chunks - spreading tens of thousands of args into
      // String.fromCharCode at once can blow the call stack on some engines.
      let result = '';
      const CHUNK_SIZE = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        result += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
      }
      return result;
    }
  }

  (PatchedTextDecoder as unknown as { __latin1Patched: boolean }).__latin1Patched = true;
  globalObject.TextDecoder = PatchedTextDecoder as unknown as typeof TextDecoder;
}

patchTextDecoderForLatin1();
