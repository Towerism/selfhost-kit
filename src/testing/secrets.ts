import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway data folder laid out like `/data`: `root/app.db` and `root/secrets/`. */
export interface TempSecretsDir {
  root: string;
  /** `root/app.db`: pass it as `NUXT_DATABASE_PATH` so secrets resolve into `secretsDir`. */
  databasePath: string;
  /** `root/secrets` */
  secretsDir: string;
  /** Removes `root` and everything in it. Call it in `afterEach`. */
  cleanup(): void;
}

/** A fresh, unique data folder. `secretsDir` is not created, as on a first boot. */
export function tempSecretsDir(): TempSecretsDir {
  const root = mkdtempSync(join(tmpdir(), 'selfhost-kit-'));
  return {
    root,
    databasePath: join(root, 'app.db'),
    secretsDir: join(root, 'secrets'),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * A data folder whose `secrets/` looks like an existing install's: the directory at `0700` and each
 * `name → value` written as `value + "\n"` at `0600`. Values must be synthetic.
 */
export function existingInstallSecrets(files: Record<string, string>): TempSecretsDir {
  const dir = tempSecretsDir();
  mkdirSync(dir.secretsDir, { mode: 0o700 });
  chmodSync(dir.secretsDir, 0o700);
  for (const [name, value] of Object.entries(files)) {
    const path = join(dir.secretsDir, name);
    writeFileSync(path, `${value}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return dir;
}
