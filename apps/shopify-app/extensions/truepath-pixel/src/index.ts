// Deploy entry — the ONLY file that touches Shopify's package. It is excluded from this app's
// typecheck (tsconfig.json) because `@shopify/web-pixels-extension` is not installed in this
// workspace: adding it is a new dependency that needs approval (CLAUDE.md), and it is only needed by
// the Shopify CLI's bundler when the extension is deployed. Everything below the `register` call is
// tested in isolation; see ../README.md for the deploy steps and what still has to be verified live.
import { register } from '@shopify/web-pixels-extension';
import { browserDeps } from './env.js';
import { startPixel } from './pixel.js';

register(({ analytics, browser, init, settings }) => {
  // Fire and forget: the pixel swallows its own errors and must never delay the storefront.
  void startPixel({ analytics, browser, init, settings }, browserDeps());
});
