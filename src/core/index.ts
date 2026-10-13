// @towerism/selfhost-kit: the framework-free core (ADR-0006). Everything here is public API (ADR-0005).

export { type StringVault, type Vault, VaultError, createVault, stringVault } from './vault/index.js';

export {
  type Env,
  InvalidSecretError,
  type SecretSource,
  type SecretSpec,
  aes256Key,
  resolveSecret,
  sessionPassword,
} from './secrets/index.js';

export { InvalidConfigError, type PreparedEnv, prepareRuntimeEnv } from './runtime/env.js';
export { type LauncherOptions, runLauncher } from './runtime/launcher.js';

export {
  type CreateLoggerOptions,
  type LogDestination,
  type LogFields,
  type LogFormat,
  type LogLevel,
  type Logger,
  createLogger,
  silentLogger,
} from './logging/logger.js';
export {
  BASE_SENSITIVE_KEYS,
  REDACTED,
  type Redactor,
  createRedactor,
  secretKeyNames,
} from './logging/redact.js';
export { acceptRequestId } from './logging/request-id.js';

export {
  type CspDirectives,
  contentSecurityPolicy,
  isHttpsSite,
  securityHeaders,
} from './security/headers.js';
export { type FixedWindowLimiter, type HitResult, createFixedWindowLimiter } from './security/rate-limit.js';
export {
  DEFAULT_TRUSTED_PROXIES,
  InvalidTrustedProxiesError,
  type TrustedProxies,
  clientKey,
  normalizeAddress,
  parseTrustedProxies,
} from './security/client-address.js';
export { type Clock, systemClock } from './clock.js';

export { generateSetupCode, setupCodeMatches } from './setup-code/index.js';
