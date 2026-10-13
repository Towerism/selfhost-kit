// @towerism/selfhost-kit/testing: contract suites and fixtures each app runs against its own
// configuration (ADR-0008). Needs Vitest. Never import it from production code.

export { describeVaultContract } from './vault-contract.js';
export { type VaultVector, VAULT_V1_VECTORS } from './vault-vectors.js';
export { describeRedactionContract } from './redaction.js';
export { type TempSecretsDir, existingInstallSecrets, tempSecretsDir } from './secrets.js';
export { type FakeClock, fakeClock } from './clock.js';
