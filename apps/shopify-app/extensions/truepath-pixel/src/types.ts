// The slice of Shopify's Web Pixels API this pixel uses (shopify-integration.md §2.2; browser API and
// standard events per https://shopify.dev/docs/api/web-pixels-api). Declared here rather than imported
// from `@shopify/web-pixels-extension` so the pixel logic has no runtime or type dependency on it:
// only the 4-line deploy entry (`index.ts`) touches that package, and it is where any drift between
// these shapes and Shopify's real ones is caught — see the extension README.
//
// Everything a callback receives is treated as untrusted structure (`unknown`), because the sandbox
// hands over whatever the storefront and Shopify produced; the mappers narrow it defensively.

export interface PixelCustomerPrivacy {
  readonly analyticsProcessingAllowed: boolean;
  readonly marketingAllowed: boolean;
}

/** `settings` set by `webPixelCreate` (LLD §2.2) — all single-line text. */
export interface PixelSettings {
  readonly storeKey?: string;
  readonly collectorUrl?: string;
  readonly signingKid?: string;
  readonly signingSecret?: string;
  readonly noticeVersion?: string;
}

export interface PixelBrowserApi {
  // Asynchronous in the strict sandbox (collector.md §2.2).
  readonly cookie: { get(name: string): Promise<string | null | undefined> };
  readonly localStorage: {
    getItem(key: string): Promise<string | null | undefined>;
    setItem(key: string, value: string): Promise<void>;
  };
}

export interface PixelApi {
  readonly analytics: {
    subscribe(eventName: string, handler: (event: unknown) => void): void;
  };
  readonly browser: PixelBrowserApi;
  readonly init: {
    readonly customerPrivacy?: Partial<PixelCustomerPrivacy> | null;
    // Where the shopper is at load, before any standard event has fired (used for consent events).
    readonly context?: {
      readonly document?: {
        readonly location?: { readonly href?: string };
        readonly referrer?: string;
      };
    };
  };
  readonly settings: PixelSettings;
}

/** Everything environmental, injected so tests are deterministic and the sandbox differences stay in one place. */
export interface PixelDeps {
  now(): number;
  /** 16 random bytes. */
  randomBytes(): Uint8Array;
  /** Lower-case hex HMAC-SHA256 — the batch signature (collector.md §4 step 3). */
  hmacSha256Hex(secret: string, message: string): Promise<string>;
  /** `fetch(url, { method: 'POST', body, keepalive: true, headers })`; the response is never read. */
  post(url: string, body: string): Promise<void>;
  /** Returns a cancel function. */
  schedule(callback: () => void, delayMs: number): () => void;
  byteLength(text: string): number;
}
