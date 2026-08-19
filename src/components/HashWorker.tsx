import * as FileSystem from 'expo-file-system/legacy';
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import {
  BLAZEFACE_JS_SOURCE,
  BLAZEFACE_MODEL_JSON,
  BLAZEFACE_WEIGHTS_BASE64,
  TF_JS_SOURCE,
} from '../assets/faceModel.generated';

// Was off for a while: every way tried to load face detection into this
// WebView kept timing out on every single photo, not just face detection,
// which looked like tf.js/blazeface itself being too much for the WebView.
// The real cause turned out to be unrelated - a stale-closure bug in this
// file's own "ready" handling (see readyRef below) that could make the very
// first photo's job never get sent at all, regardless of what was or
// wasn't loaded. Now that that's fixed, back on.
const FACE_DETECTION_ENABLED = true;

const FACE_MODEL_DIR = (FileSystem.cacheDirectory ?? '') + 'facemodel/';

/**
 * Writes tf.js, blazeface, and the blazeface model out as real files instead
 * of embedding them inline in the WebView's HTML: that inline HTML crosses
 * into the native WebView as a single message, and Android has a hard cap
 * on how much data that can carry at once (around 1MB) - comfortably over
 * that (the embedded libraries alone are ~1.5MB) silently broke the page
 * load, which was hanging (and eventually timing out) every single photo,
 * not just face detection. Loading them as files the WebView reads off disk
 * itself has no such limit.
 */
const FACE_MODEL_FILES = ['tf.min.js', 'blazeface.min.js', 'model.json', 'group1-shard1of1.bin'];

async function ensureFaceModelFiles(): Promise<void> {
  if (!FACE_DETECTION_ENABLED) return;

  // Written once and reused across scans/app launches (same cache directory
  // each time) - re-writing ~2MB before every single scan would be
  // wasteful. Checks every file, not just one: an earlier attempt could
  // have been interrupted partway through (e.g. the app was closed mid-scan
  // during testing), leaving some files present and others missing - which
  // would silently and permanently fail every face detection from then on,
  // since a single missing file (like the library itself) breaks the
  // <script src> chain that depends on it.
  const infos = await Promise.all(
    FACE_MODEL_FILES.map((name) => FileSystem.getInfoAsync(FACE_MODEL_DIR + name))
  );
  if (infos.every((info) => info.exists)) return;

  await FileSystem.makeDirectoryAsync(FACE_MODEL_DIR, { intermediates: true });
  await Promise.all([
    FileSystem.writeAsStringAsync(FACE_MODEL_DIR + 'tf.min.js', TF_JS_SOURCE),
    FileSystem.writeAsStringAsync(FACE_MODEL_DIR + 'blazeface.min.js', BLAZEFACE_JS_SOURCE),
    FileSystem.writeAsStringAsync(FACE_MODEL_DIR + 'model.json', JSON.stringify(BLAZEFACE_MODEL_JSON)),
    FileSystem.writeAsStringAsync(FACE_MODEL_DIR + 'group1-shard1of1.bin', BLAZEFACE_WEIGHTS_BASE64, {
      encoding: FileSystem.EncodingType.Base64,
    }),
  ]);
}

// Difference-hash (dHash): the tiny image is 9x8 pixels; for each of the 8
// rows we compare 8 adjacent pixel pairs, giving a 64-bit fingerprint that's
// stable across resizing, re-compression and minor quality loss - exactly
// the kind of "same photo, different copy" duplicates we need to catch.
//
// Sharpness: separately drawn at 220x220 (much bigger than the 9x9 hash) so
// there's enough real detail to measure blur via the variance of the
// Laplacian (a standard blur-detection trick - blurry images have weaker
// edges, so the second-derivative response varies less across the image).
//
// Face-aware sharpness: a photo with a sharp, detailed background but an
// out-of-focus face used to score as "sharp" overall, which is backwards for
// photos of people. When a face can be found (via BlazeFace), sharpness is
// measured just in the face area instead of the whole frame. If no face is
// found, it falls back to whole-image sharpness like before.
//
// tf.js, blazeface, and the blazeface model weights are all vendored into
// the app (see ../assets/faceModel.generated.ts, written to disk by
// ensureFaceModelFiles above) rather than fetched from a CDN at scan time:
// this used to make a real network call for every scan, and on a slow
// connection that call could block the page from finishing load at all -
// which blocked hashing every photo behind it, not just face detection.
// They're loaded here as plain local files (not embedded inline in this
// HTML) because the inline HTML has to cross into the native WebView as a
// single message, and Android caps how much that can carry at once - these
// libraries alone are bigger than that cap. Local files the WebView reads
// off disk itself have no such limit, and still need no internet connection.
const ANALYZE_HTML = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0">
<canvas id="c" width="9" height="8" style="display:none"></canvas>
<canvas id="b" width="220" height="220" style="display:none"></canvas>
${
  FACE_DETECTION_ENABLED
    ? `<script src="tf.min.js"></script>
<script src="blazeface.min.js"></script>`
    : ''
}
<script>
  var hashCanvas = document.getElementById('c');
  var hashCtx = hashCanvas.getContext('2d');
  var blurCanvas = document.getElementById('b');
  var blurCtx = blurCanvas.getContext('2d');
  var BLUR_SIZE = 220;

  var faceModel = null;
  var faceModelFailed = false;
  ${
    FACE_DETECTION_ENABLED
      ? `(function loadFaceModel() {
    try {
      if (typeof tf === 'undefined') {
        post({ faceModelStatus: 'failed', faceModelError: 'tf.min.js pas chargé (typeof tf === undefined)' });
        faceModelFailed = true;
        return;
      }
      if (typeof blazeface === 'undefined') {
        post({ faceModelStatus: 'failed', faceModelError: 'blazeface.min.js pas chargé (typeof blazeface === undefined)' });
        faceModelFailed = true;
        return;
      }
      blazeface.load({ modelUrl: 'model.json' }).then(function (model) {
        faceModel = model;
        post({ faceModelStatus: 'ok' });
      }).catch(function (e) {
        faceModelFailed = true;
        post({ faceModelStatus: 'failed', faceModelError: 'blazeface.load a échoué : ' + String(e) });
      });
    } catch (e) {
      faceModelFailed = true;
      post({ faceModelStatus: 'failed', faceModelError: 'exception : ' + String(e) });
    }
  })();`
      : 'faceModelFailed = true;'
  }

  function post(message) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  function computeHashBits() {
    var data = hashCtx.getImageData(0, 0, 9, 8).data;
    var gray = new Array(72);
    for (var i = 0; i < 72; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    var bits = '';
    for (var y = 0; y < 8; y++) {
      for (var x = 0; x < 8; x++) {
        bits += gray[y * 9 + x] < gray[y * 9 + x + 1] ? '1' : '0';
      }
    }
    return bits;
  }

  // Laplacian variance restricted to a sub-rectangle of the blur canvas -
  // same math as before, just optionally zoomed into the face area.
  function computeSharpnessInRegion(rx, ry, rw, rh) {
    var data = blurCtx.getImageData(0, 0, BLUR_SIZE, BLUR_SIZE).data;
    var w = BLUR_SIZE;
    var x0 = Math.max(1, rx);
    var y0 = Math.max(1, ry);
    var x1 = Math.min(w - 2, rx + rw);
    var y1 = Math.min(BLUR_SIZE - 2, ry + rh);
    if (x1 <= x0 || y1 <= y0) {
      x0 = 1; y0 = 1; x1 = w - 2; y1 = BLUR_SIZE - 2;
    }

    function gray(px, py) {
      var idx = (py * w + px) * 4;
      return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    }

    var lap = [];
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        lap.push(gray(x - 1, y) + gray(x + 1, y) + gray(x, y - 1) + gray(x, y + 1) - 4 * gray(x, y));
      }
    }
    var n = lap.length;
    var mean = 0;
    for (var k = 0; k < n; k++) mean += lap[k];
    mean /= n;
    var variance = 0;
    for (var k = 0; k < n; k++) {
      var d = lap[k] - mean;
      variance += d * d;
    }
    return variance / n;
  }

  // Never lets a slow/hung face-detection call (bad network, a WebView with
  // broken WebGL, etc.) block the analysis of a photo - whatever happens,
  // this settles within FACE_TIMEOUT_MS and analysis falls back to
  // whole-image sharpness for that photo.
  var FACE_TIMEOUT_MS = 4000;
  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, ms);
      promise
        .then(function (value) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(value);
          }
        })
        .catch(function () {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(null);
          }
        });
    });
  }

  async function detectFaceRegion() {
    if (!faceModel) return null;
    try {
      var predictions = await withTimeout(faceModel.estimateFaces(blurCanvas, false), FACE_TIMEOUT_MS);
      if (!predictions || predictions.length === 0) return null;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < predictions.length; i++) {
        var p = predictions[i];
        minX = Math.min(minX, p.topLeft[0]);
        minY = Math.min(minY, p.topLeft[1]);
        maxX = Math.max(maxX, p.bottomRight[0]);
        maxY = Math.max(maxY, p.bottomRight[1]);
      }
      // A little padding around the detected box so the measured region
      // isn't literally just eyes/nose/mouth (too small and flat to judge
      // sharpness well) - but not so much that it starts pulling in the
      // background around the face, which would defeat the point of
      // measuring the face specifically instead of the whole photo.
      var padX = (maxX - minX) * 0.15;
      var padY = (maxY - minY) * 0.15;
      minX = Math.max(0, minX - padX);
      minY = Math.max(0, minY - padY);
      maxX = Math.min(BLUR_SIZE, maxX + padX);
      maxY = Math.min(BLUR_SIZE, maxY + padY);
      return {
        x: Math.round(minX),
        y: Math.round(minY),
        w: Math.round(maxX - minX),
        h: Math.round(maxY - minY),
      };
    } catch (e) {
      return null;
    }
  }

  function handleAnalyze(id, base64, needSharpness) {
    var img = new Image();
    img.onload = async function () {
      try {
        hashCtx.clearRect(0, 0, 9, 8);
        hashCtx.drawImage(img, 0, 0, 9, 8);
        var hash = computeHashBits();

        // The duplicates step only ever needs the hash - skipping the
        // sharpness/face-detection work entirely keeps that step (often run
        // first, on a big folder with lots of subfolders) as fast and
        // simple as possible.
        if (!needSharpness) {
          post({ id: id, hash: hash, sharpness: 0, facesFound: false });
          return;
        }

        blurCtx.clearRect(0, 0, BLUR_SIZE, BLUR_SIZE);
        blurCtx.drawImage(img, 0, 0, BLUR_SIZE, BLUR_SIZE);

        var faceRegion = await detectFaceRegion();
        var sharpness = faceRegion
          ? computeSharpnessInRegion(faceRegion.x, faceRegion.y, faceRegion.w, faceRegion.h)
          : computeSharpnessInRegion(0, 0, BLUR_SIZE, BLUR_SIZE);

        post({ id: id, hash: hash, sharpness: sharpness, facesFound: !!faceRegion });
      } catch (e) {
        post({ id: id, error: String(e) });
      }
    };
    img.onerror = function () {
      post({ id: id, error: 'decode_failed' });
    };
    img.src = 'data:image/png;base64,' + base64;
  }

  // The WebView's own onLoadEnd event is unreliable for source={{ html }}
  // content on Android (a known react-native-webview issue - it can just
  // never fire even though the page loaded fine) - so the page announces
  // its own readiness instead of relying on that.
  post({ ready: true });
  true;
</script>
</body>
</html>
`;

export type PhotoMetrics = {
  /** 64-bit dHash, as a string of '0'/'1' characters. */
  hash: string;
  /** Variance of the Laplacian - higher means sharper. Only meaningful when
   *  comparing photos of the same scene against each other. */
  sharpness: number;
  /** Whether the sharpness score above was measured on a detected face
   *  instead of the whole photo. */
  facesFound: boolean;
};

type PendingEntry = {
  resolve: (metrics: PhotoMetrics) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type HashWorkerHandle = {
  /**
   * Computes the dHash and, unless `needSharpness` is explicitly false, a
   * sharpness score for a tiny base64-encoded PNG. Skipping sharpness (the
   * duplicates step doesn't use it at all) keeps that step as fast and
   * simple as possible.
   */
  computeMetrics: (
    base64Png: string,
    options?: { needSharpness?: boolean }
  ) => Promise<PhotoMetrics>;
  /** Why face detection did or didn't come up during this scan, for on-screen debugging. */
  getFaceModelDiagnostic: () => string | null;
};

const REQUEST_TIMEOUT_MS = 25000;

const HashWorker = forwardRef<HashWorkerHandle>((_props, ref) => {
  const webViewRef = useRef<WebView>(null);
  const [assetsReady, setAssetsReady] = useState(false);
  // A ref, not state: flushQueue and the timeout handler below both need
  // the *current* value the instant the "ready" message arrives, but a
  // function defined during an earlier render only ever sees the `ready`
  // state as it was at that render - calling setReady(true) doesn't change
  // what an already-created closure reads. That mismatch meant the very
  // first photo's job could be queued, "ready" could arrive right after,
  // and flushQueue (called from that same stale closure) would still see
  // ready=false and never actually send it - a guaranteed timeout on every
  // single scan. A ref's .current is always the latest value, closure or not.
  const readyRef = useRef(false);
  const pending = useRef<Map<number, PendingEntry>>(new Map());
  const nextId = useRef(0);
  const queue = useRef<Array<{ id: number; base64: string; needSharpness: boolean }>>([]);
  // Tracks *why* the page never responded, for when a request times out -
  // "the WebView's page never finished loading" vs "it crashed" vs "it
  // loaded fine but never answered" are very different problems to chase,
  // and a bare "hash_timeout" can't tell them apart.
  const diagnosis = useRef<string | null>(null);
  const faceModelDiagnostic = useRef<string | null>(FACE_DETECTION_ENABLED ? null : 'désactivée');

  useEffect(() => {
    let cancelled = false;
    ensureFaceModelFiles()
      .catch(() => {
        // Face detection just won't be available this scan - hashing itself
        // doesn't depend on any of this.
      })
      .finally(() => {
        if (!cancelled) setAssetsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function flushQueue() {
    if (!readyRef.current) return;
    const jobs = queue.current;
    queue.current = [];
    for (const job of jobs) {
      webViewRef.current?.injectJavaScript(
        `handleAnalyze(${JSON.stringify(job.id)}, ${JSON.stringify(job.base64)}, ${job.needSharpness}); true;`
      );
    }
  }

  useImperativeHandle(ref, () => ({
    computeMetrics(base64Png: string, options?: { needSharpness?: boolean }) {
      const id = nextId.current++;
      const needSharpness = options?.needSharpness ?? true;
      return new Promise<PhotoMetrics>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.current.delete(id);
          const reason =
            diagnosis.current ?? (readyRef.current ? 'page chargée mais muette' : 'page jamais chargée');
          reject(new Error(`hash_timeout (${reason})`));
        }, REQUEST_TIMEOUT_MS);
        pending.current.set(id, { resolve, reject, timeout });
        queue.current.push({ id, base64: base64Png, needSharpness });
        flushQueue();
      });
    },
    getFaceModelDiagnostic() {
      return faceModelDiagnostic.current;
    },
  }));

  function handleMessage(event: WebViewMessageEvent) {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as {
        id?: number;
        ready?: boolean;
        hash?: string;
        sharpness?: number;
        facesFound?: boolean;
        error?: string;
        faceModelStatus?: 'ok' | 'failed';
        faceModelError?: string;
      };
      if (payload.ready) {
        readyRef.current = true;
        flushQueue();
        return;
      }
      if (payload.faceModelStatus) {
        faceModelDiagnostic.current =
          payload.faceModelStatus === 'ok' ? 'ok' : (payload.faceModelError ?? 'échec inconnu');
        return;
      }
      if (payload.id === undefined) return;
      const entry = pending.current.get(payload.id);
      if (!entry) return;
      pending.current.delete(payload.id);
      clearTimeout(entry.timeout);
      if (payload.hash && payload.sharpness !== undefined) {
        entry.resolve({
          hash: payload.hash,
          sharpness: payload.sharpness,
          facesFound: !!payload.facesFound,
        });
      } else {
        entry.reject(new Error(payload.error ?? 'unknown_error'));
      }
    } catch {
      // Ignore malformed messages.
    }
  }

  if (!assetsReady) return null;

  return (
    <WebView
      ref={webViewRef}
      originWhitelist={['*']}
      source={
        FACE_DETECTION_ENABLED
          ? { html: ANALYZE_HTML, baseUrl: 'file://' + FACE_MODEL_DIR }
          : { html: ANALYZE_HTML }
      }
      allowFileAccess
      allowFileAccessFromFileURLs
      allowUniversalAccessFromFileURLs
      onLoadEnd={() => {
        readyRef.current = true;
        flushQueue();
      }}
      onError={(e) => {
        diagnosis.current = `échec de chargement : ${e.nativeEvent.description}`;
      }}
      onHttpError={(e) => {
        diagnosis.current = `erreur HTTP ${e.nativeEvent.statusCode}`;
      }}
      onRenderProcessGone={(e) => {
        diagnosis.current = `page fermée par le téléphone (didCrash: ${e.nativeEvent.didCrash})`;
        readyRef.current = false;
      }}
      onMessage={handleMessage}
      javaScriptEnabled
      style={styles.hidden}
    />
  );
});

HashWorker.displayName = 'HashWorker';

const styles = StyleSheet.create({
  // The worker has no visible UI - it's a headless canvas used purely for
  // native-quality image decoding, which isn't otherwise available in JS.
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
});

export default HashWorker;
