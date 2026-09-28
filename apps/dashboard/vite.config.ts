import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// React + Vite dashboard (ADR-0010). shadcn/ui components (@/components/ui/*) resolve through the
// `@/*` alias, matching tsconfig.json's paths.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Local-dev-only: lets the dashboard be reached through an ngrok tunnel (needed to test the
    // real Shopify OAuth flow, whose callback must be a public HTTPS URL). Vite otherwise rejects
    // requests whose Host header isn't localhost-like. Never relevant outside a developer's own
    // machine — production serves the built dashboard as static files, not via this dev server.
    allowedHosts: true,
    proxy: {
      // Same-origin API access while tunnelled: the dashboard's own fetches, and Shopify's OAuth
      // callback redirect, all land on the one tunnel origin, so the session cookie set at login
      // is actually present when the callback runs its own-session check (ADR-0025).
      '/v1': { target: 'http://localhost:3000', changeOrigin: true },
      '/webhooks': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
