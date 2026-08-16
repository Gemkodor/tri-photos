import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

// Difference-hash (dHash): the tiny image is 9x8 pixels; for each of the 8
// rows we compare 8 adjacent pixel pairs, giving a 64-bit fingerprint that's
// stable across resizing, re-compression and minor quality loss - exactly
// the kind of "same photo, different copy" duplicates we need to catch.
const HASH_HTML = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0">
<canvas id="c" width="9" height="8" style="display:none"></canvas>
<script>
  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d');

  function post(message) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  }

  function handleHash(id, base64) {
    var img = new Image();
    img.onload = function () {
      try {
        ctx.clearRect(0, 0, 9, 8);
        ctx.drawImage(img, 0, 0, 9, 8);
        var data = ctx.getImageData(0, 0, 9, 8).data;
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
        post({ id: id, hash: bits });
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

type PendingEntry = {
  resolve: (hash: string) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type HashWorkerHandle = {
  /** Computes a 64-bit dHash (as a string of 64 '0'/'1' chars) for a tiny base64-encoded PNG. */
  computeHash: (base64Png: string) => Promise<string>;
};

const REQUEST_TIMEOUT_MS = 15000;

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
        `handleHash(${JSON.stringify(job.id)}, ${JSON.stringify(job.base64)}); true;`
      );
    }
  }

  useImperativeHandle(ref, () => ({
    computeHash(base64Png: string) {
      const id = nextId.current++;
      return new Promise<string>((resolve, reject) => {
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
        error?: string;
      };
      const entry = pending.current.get(payload.id);
      if (!entry) return;
      pending.current.delete(payload.id);
      clearTimeout(entry.timeout);
      if (payload.hash) {
        entry.resolve(payload.hash);
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
      source={{ html: HASH_HTML }}
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
