import { describe, expect, it } from 'vitest';
import * as core from '../src/core/index.js';
import * as nitro from '../src/nitro/index.js';
import * as testing from '../src/testing/index.js';

// The runtime surface is public API (ADR-0005): a change here is a deliberate, reviewed change.
describe('entry points', () => {
  it('the core exports exactly its K1 API', () => {
    expect(Object.keys(core).sort()).toEqual(
      [
        'BASE_SENSITIVE_KEYS',
        'DEFAULT_TRUSTED_PROXIES',
        'InvalidConfigError',
        'InvalidSecretError',
        'InvalidTrustedProxiesError',
        'REDACTED',
        'VaultError',
        'acceptRequestId',
        'aes256Key',
        'clientKey',
        'contentSecurityPolicy',
        'createFixedWindowLimiter',
        'createLogger',
        'createRedactor',
        'createVault',
        'generateSetupCode',
        'isHttpsSite',
        'normalizeAddress',
        'parseTrustedProxies',
        'prepareRuntimeEnv',
        'resolveSecret',
        'runLauncher',
        'secretKeyNames',
        'securityHeaders',
        'sessionPassword',
        'setupCodeMatches',
        'silentLogger',
        'stringVault',
        'systemClock',
      ].sort(),
    );
  });

  it('/testing exports exactly its K1 helpers', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'VAULT_V1_VECTORS',
      'describeRedactionContract',
      'describeVaultContract',
      'existingInstallSecrets',
      'fakeClock',
      'tempSecretsDir',
    ]);
  });

  it('/nitro is still empty until K2', () => {
    expect(Object.keys(nitro)).toEqual([]);
  });

  it('every error class names itself', () => {
    for (const ErrorClass of [
      core.VaultError,
      core.InvalidSecretError,
      core.InvalidConfigError,
      core.InvalidTrustedProxiesError,
    ]) {
      expect(new ErrorClass('x').name).toBe(ErrorClass.name);
    }
  });
});
