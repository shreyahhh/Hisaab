import type { PixelDeps } from './types.js';

// The real sandbox implementations of `PixelDeps`. Web Worker globals only: `fetch`, Web Crypto,
// `TextEncoder`, `setTimeout`. The strict sandbox has no DOM, cookies or `sendBeacon` (deprecated —
// collector.md §2.1), which is why sends use `fetch(..., { keepalive: true })`.

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function browserDeps(): PixelDeps {
  return {
    now: () => Date.now(),

    randomBytes: () => {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    },

    hmacSha256Hex: async (secret, message) => {
      const key = await globalThis.crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      return toHex(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(message)));
    },

    post: async (url, body) => {
      // A string body is sent as `text/plain;charset=UTF-8`, a CORS "simple request": no preflight
      // (collector.md §2.1). `credentials: 'omit'` because the Collector sets and reads no cookies
      // and answers `Access-Control-Allow-Origin: *`, which browsers refuse alongside credentials.
      await fetch(url, { method: 'POST', body, keepalive: true, credentials: 'omit' });
    },

    schedule: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    },

    byteLength: (text) => encoder.encode(text).length,
  };
}
