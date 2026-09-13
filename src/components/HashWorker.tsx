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

/**
 * This used to also compute the perceptual hash and whole-image sharpness -
 * that math now runs in plain JS (see pixelAnalysis.ts), specifically so it
 * survives Android pausing this WebView's own JavaScript the instant the
 * screen locks or the app is backgrounded (a foreground service keeps the
 * *app* alive, but doesn't stop a WebView's timers/scripts from being
 * suspended while it isn't visible - confirmed the real cause of analysis
 * stalling in the background, not just Expo Go). Only face detection is
 * left here, since blazeface genuinely needs this WebView's tf.js - and
 * `detectFace` below never rejects or hangs forever waiting on it: a photo
 * processed while backgrounded just falls back to whole-image sharpness,
 * the same as any photo with no detectable face.
 */
const FACE_DETECTION_ENABLED = true;

const FACE_MODEL_DIR = (FileSystem.cacheDirectory ?? '') + 'facemodel/';
const FACE_MODEL_FILES = ['tf.min.js', 'blazeface.min.js'];
/** Must match pixelAnalysis's sharpness render size - a face box found here is used directly against that image. */
export const FACE_DETECT_SIZE = 220;

async function ensureFaceModelFiles(): Promise<void> {
  if (!FACE_DETECTION_ENABLED) return;
  const infos = await Promise.all(
    FACE_MODEL_FILES.map((name) => FileSystem.getInfoAsync(FACE_MODEL_DIR + name))
  );
  if (infos.every((info) => info.exists)) return;

  await FileSystem.makeDirectoryAsync(FACE_MODEL_DIR, { intermediates: true });
  await Promise.all([
    FileSystem.writeAsStringAsync(FACE_MODEL_DIR + 'tf.min.js', TF_JS_SOURCE),
    FileSystem.writeAsStringAsync(FACE_MODEL_DIR + 'blazeface.min.js', BLAZEFACE_JS_SOURCE),
  ]);
}

const DETECT_HTML = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0">
<canvas id="b" width="${FACE_DETECT_SIZE}" height="${FACE_DETECT_SIZE}" style="display:none"></canvas>
${
  FACE_DETECTION_ENABLED
    ? `<script src="tf.min.js"></script>
<script src="blazeface.min.js"></script>`
    : ''
}
<script>
  var blurCanvas = document.getElementById('b');
  var blurCtx = blurCanvas.getContext('2d');
  var BLUR_SIZE = ${FACE_DETECT_SIZE};

  var faceModel = null;
  var faceModelFailed = false;
  ${
    FACE_DETECTION_ENABLED
      ? `var BLAZEFACE_MODEL_JSON = ${JSON.stringify(BLAZEFACE_MODEL_JSON)};
  var BLAZEFACE_WEIGHTS_BASE64 = ${JSON.stringify(BLAZEFACE_WEIGHTS_BASE64)};

  function base64ToArrayBuffer(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  (function loadFaceModel() {
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
      var handler = tf.io.fromMemory({
        modelTopology: BLAZEFACE_MODEL_JSON.modelTopology,
        weightSpecs: BLAZEFACE_MODEL_JSON.weightsManifest[0].weights,
        weightData: base64ToArrayBuffer(BLAZEFACE_WEIGHTS_BASE64),
        format: BLAZEFACE_MODEL_JSON.format,
        generatedBy: BLAZEFACE_MODEL_JSON.generatedBy,
        convertedBy: BLAZEFACE_MODEL_JSON.convertedBy,
      });
      blazeface.load({ modelUrl: handler }).then(function (model) {
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

  // Never lets a slow/hung face-detection call block anything - whatever
  // happens, this settles within FACE_TIMEOUT_MS and detection is reported
  // as "no face" for that photo.
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

  function handleDetect(id, base64) {
    var img = new Image();
    img.onload = async function () {
      try {
        blurCtx.clearRect(0, 0, BLUR_SIZE, BLUR_SIZE);
        blurCtx.drawImage(img, 0, 0, BLUR_SIZE, BLUR_SIZE);
        var region = await detectFaceRegion();
        post({ id: id, region: region });
      } catch (e) {
        post({ id: id, region: null, error: String(e) });
      }
    };
    img.onerror = function () {
      post({ id: id, region: null, error: 'decode_failed' });
    };
    img.src = 'data:image/png;base64,' + base64;
  }

  // The WebView's own onLoadEnd event is unreliable for source={{ html }}
  // content on Android (a known react-native-webview issue) - so the page
  // announces its own readiness instead of relying on that.
  post({ ready: true });
  true;
</script>
</body>
</html>
`;

export type FaceRegion = { x: number; y: number; w: number; h: number };

type PendingEntry = {
  resolve: (region: FaceRegion | null) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type HashWorkerHandle = {
  /**
   * Looks for a face in a base64-encoded PNG already resized to
   * FACE_DETECT_SIZE x FACE_DETECT_SIZE. Never rejects and never hangs
   * forever - resolves null (same as "no face found") if the WebView is
   * slow, paused (e.g. app backgrounded), or anything else goes wrong, so
   * the caller can always fall back to whole-image sharpness rather than
   * getting stuck waiting.
   */
  detectFace: (base64Png: string) => Promise<FaceRegion | null>;
  /** Why face detection did or didn't come up during this scan, for on-screen debugging. */
  getFaceModelDiagnostic: () => string | null;
};

/**
 * Generous while the app is in the foreground (a slow phone or a big model
 * load shouldn't cost a false "no face"), but this is exactly the timer
 * that keeps the analysis moving when the WebView itself is suspended in
 * the background - it lives here in the calling JS, not inside the
 * WebView's own withTimeout, since a fully paused WebView can't even run
 * its own setTimeout to rescue itself.
 */
const REQUEST_TIMEOUT_MS = 8000;

const HashWorker = forwardRef<HashWorkerHandle>((_props, ref) => {
  const webViewRef = useRef<WebView>(null);
  const [assetsReady, setAssetsReady] = useState(false);
  const readyRef = useRef(false);
  const pending = useRef<Map<number, PendingEntry>>(new Map());
  const nextId = useRef(0);
  const queue = useRef<Array<{ id: number; base64: string }>>([]);
  const faceModelDiagnostic = useRef<string | null>(FACE_DETECTION_ENABLED ? null : 'désactivée');

  useEffect(() => {
    let cancelled = false;
    ensureFaceModelFiles()
      .catch(() => {
        // Face detection just won't be available this scan - not critical.
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
        `handleDetect(${JSON.stringify(job.id)}, ${JSON.stringify(job.base64)}); true;`
      );
    }
  }

  useImperativeHandle(ref, () => ({
    detectFace(base64Png: string) {
      const id = nextId.current++;
      return new Promise<FaceRegion | null>((resolve) => {
        const timeout = setTimeout(() => {
          pending.current.delete(id);
          resolve(null);
        }, REQUEST_TIMEOUT_MS);
        pending.current.set(id, { resolve, timeout });
        queue.current.push({ id, base64: base64Png });
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
        region?: FaceRegion | null;
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
      entry.resolve(payload.region ?? null);
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
          ? { html: DETECT_HTML, baseUrl: FACE_MODEL_DIR }
          : { html: DETECT_HTML }
      }
      allowFileAccess
      allowFileAccessFromFileURLs
      allowUniversalAccessFromFileURLs
      onLoadEnd={() => {
        readyRef.current = true;
        flushQueue();
      }}
      onRenderProcessGone={() => {
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
  // The worker has no visible UI - it's a headless page used purely for
  // face detection, which isn't otherwise available without native code.
  hidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
});

export default HashWorker;
