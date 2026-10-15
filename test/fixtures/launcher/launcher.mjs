// An app's launcher, run as a real process by the launcher tests. SCENARIO picks what `prepare` does.
import { InvalidConfigError, prepareRuntimeEnv } from '../../../src/core/runtime/env.js';
import { createLogger } from '../../../src/core/logging/logger.js';
import { createRedactor } from '../../../src/core/logging/redact.js';
import { runLauncher } from '../../../src/core/runtime/launcher.js';
import { aes256Key } from '../../../src/core/secrets/index.js';

const SECRETS = [aes256Key({ env: 'NUXT_APP_VAULT_KEY', file: 'vault.key', label: 'Vault key' })];

const prepare = {
  valid: (env) => prepareRuntimeEnv(env, { secrets: SECRETS, positiveIntegerVars: ['NUXT_TUNING'] }),
  'invalid-config': () => {
    throw new InvalidConfigError('NUXT_TUNING must be a whole number of at least 1 (got "abc").');
  },
  'plain-error': () => {
    throw new Error('a bug in prepare');
  },
}[process.env.SCENARIO ?? 'valid'];

const server = new URL(
  process.env.BROKEN_SERVER === '1' ? './broken-server.mjs' : './server.mjs',
  import.meta.url,
);

await runLauncher({
  prepare,
  server,
  logger: createLogger({ scope: 'startup', redactor: createRedactor() }),
});
