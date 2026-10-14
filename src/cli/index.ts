// The `selfhost-kit` command (bin/selfhost-kit.mjs). Not part of the package's import API.
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What `docker-assets` copies out of the package's `docker/`, and the mode each copy gets. */
export const DOCKER_ASSETS = [
  { name: 'entrypoint.sh', mode: 0o755 },
  { name: 'fetch-litestream.sh', mode: 0o755 },
  { name: 'litestream.yml', mode: 0o644 },
] as const;

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const USAGE = 'Usage: selfhost-kit docker-assets <dir>';

const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

/**
 * Runs `selfhost-kit <argv…>`. `docker-assets <dir>` copies the Docker assets into `dir` as real files
 * (pnpm's symlinked node_modules can't be `COPY`'d from a Dockerfile), so an app's build can do
 * `pnpm exec selfhost-kit docker-assets .output/selfhost-kit` and `COPY` from there (ADR-0004).
 *
 * @returns the process exit code: 0 done, 1 a copy failed, 2 a usage error.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = processIo,
  options: { assetsDir?: URL | string } = {},
): Promise<number> {
  const [command, target, ...rest] = argv;
  if (argv.length === 1 && (command === '--help' || command === '-h')) {
    io.stdout(USAGE);
    return 0;
  }
  if (command !== 'docker-assets' || !target || rest.length > 0) {
    io.stderr(USAGE);
    return 2;
  }

  const source = options.assetsDir ?? new URL('../../docker/', import.meta.url);
  const sourceDir = source instanceof URL ? fileURLToPath(source) : source;
  try {
    await mkdir(target, { recursive: true });
    for (const { name, mode } of DOCKER_ASSETS) {
      // copyFile follows symlinks, so the copy is always a regular file with the asset's bytes.
      await copyFile(join(sourceDir, name), join(target, name));
      await chmod(join(target, name), mode);
      io.stdout(`copied ${name}`);
    }
  } catch (error) {
    io.stderr(`selfhost-kit: ${(error as Error).message}`);
    return 1;
  }
  return 0;
}
