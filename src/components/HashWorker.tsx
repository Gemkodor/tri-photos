import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

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
// photos of people. When a face can be found (via BlazeFace, loaded from a
// CDN over the network - the only network calls this app makes, and only to
// fetch that model, never to send any photo data anywhere), sharpness is
// measured just in the face area instead of the whole frame. If no face is
// found, or the model couldn't load (e.g. no internet the first time), it
// falls back to whole-image sharpness like before.
const ANALYZE_HTML = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0">
<canvas id="c" width="9" height="8" style="display:none"></canvas>
<canvas id="b" width="220" height="220" style="display:none"></canvas>
<script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@tensorflow-models/blazeface@0.1.0/dist/blazeface.min.js"></script>
<script>
  var hashCanvas = document.getElementById('c');
  var hashCtx = hashCanvas.getContext('2d');
  var blurCanvas = document.getElementById('b');
  var blurCtx = blurCanvas.getContext('2d');
  var BLUR_SIZE = 220;

  var faceModel = null;
  var faceModelFailed = false;
  (function loadFaceModel() {
    try {
      if (typeof tf === 'undefined' || typeof blazeface === 'undefined') {
        faceModelFailed = true;
        return;
      }
      blazeface.load().then(function (model) {
        faceModel = model;
      }).catch(function () {
        faceModelFailed = true;
      });
    } catch (e) {
      faceModelFailed = true;
    }
  })();

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
      var padX = (maxX - minX) * 0.4;
      var padY = (maxY - minY) * 0.4;
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

  async function handleAnalyze(id, base64) {
    var img = new Image();
    img.onload = async function () {
      try {
        hashCtx.clearRect(0, 0, 9, 8);
        hashCtx.drawImage(img, 0, 0, 9, 8);
        var hash = computeHashBits();

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
  /** Computes the dHash and a sharpness score for a tiny base64-encoded PNG. */
  computeMetrics: (base64Png: string) => Promise<PhotoMetrics>;
};

const REQUEST_TIMEOUT_MS = 25000;

const HashWorker = forwardRef<HashWorkerHandle>((_props, ref) => {
  const webViewRef = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const pending = useRef<Map<number, PendingEntry>>(new Map());
  const nextId = useRef(0);
  const queue = useRef<Array<{ id: number; base64: string }>>([]);

  function flushQueue() {
    if (!ready) return;
    const jobs = queue.current;
    queue.current = [];
    for (const job of jobs) {
      webViewRef.current?.injectJavaScript(
        `handleAnalyze(${JSON.stringify(job.id)}, ${JSON.stringify(job.base64)}); true;`
      );
    }
  }

  useImperativeHandle(ref, () => ({
    computeMetrics(base64Png: string) {
      const id = nextId.current++;
      return new Promise<PhotoMetrics>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.current.delete(id);
          reject(new Error('hash_timeout'));
        }, REQUEST_TIMEOUT_MS);
        pending.current.set(id, { resolve, reject, timeout });
        queue.current.push({ id, base64: base64Png });
        flushQueue();
      });
    },
  }));

  function handleMessage(event: WebViewMessageEvent) {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as {
        id: number;
        hash?: string;
        sharpness?: number;
        facesFound?: boolean;
        error?: string;
      };
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

  return (
    <WebView
      ref={webViewRef}
      originWhitelist={['*']}
      source={{ html: ANALYZE_HTML }}
      onLoadEnd={() => {
        setReady(true);
        flushQueue();
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
