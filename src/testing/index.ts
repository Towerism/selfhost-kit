// @towerism/selfhost-kit/testing: contract suites and fixtures each app runs against its own
// configuration (ADR-0008). Needs Vitest and h3. Never import it from production code.

export { describeVaultContract } from './vault-contract.js';
export { type VaultVector, VAULT_V1_VECTORS } from './vault-vectors.js';
export { describeRedactionContract } from './redaction.js';
export { type TempSecretsDir, existingInstallSecrets, tempSecretsDir } from './secrets.js';
export { type FakeClock, fakeClock } from './clock.js';
export { type H3TestApp, type H3TestAppOptions, h3TestApp } from './h3-app.js';
export { describeBodySize, describeJsonOnly, describeSecurityHeaders } from './middleware.js';
