// @towerism/selfhost-kit/nitro: thin h3/Nitro adapters over the core (ADR-0006). They take their configuration
// as arguments and never import nitropack, nuxt or #imports. Everything here is public API (ADR-0005).

export { type BodySizeLimitOptions, type JsonOnlyOptions, bodySizeLimit, jsonOnly } from './middleware.js';
export {
  type RequestLogPluginOptions,
  type SecurityHeadersPluginOptions,
  requestLogPlugin,
  securityHeadersPlugin,
} from './plugins.js';
export { type RateLimitOptions, enforceRateLimit } from './rate-limit.js';
export { jsonErrorHandler } from './error.js';
export type {
  DefaultErrorHandler,
  DefaultErrorResponse,
  JsonErrorHandler,
  NitroAppLike,
  NitroAppPlugin,
} from './types.js';
