// The `selfhost-kit` command (bin/selfhost-kit.mjs). Not part of the package's import API.
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, rm } from 'node:fs/promises';
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
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    io.stdout(USAGE);
    return 0;
  }
  // A <dir> starting with "-" is a mistyped option, not a directory to create (./-name still works).
  if (command !== 'docker-assets' || !target || target.startsWith('-') || rest.length > 0) {
    io.stderr(USAGE);
    return 2;
  }

  const source = options.assetsDir ?? new URL('../../docker/', import.meta.url);
  const sourceDir = source instanceof URL ? fileURLToPath(source) : source;
  try {
    await mkdir(target, { recursive: true });
    // Checked up front, so a refusal leaves every destination as it was.
    for (const { name } of DOCKER_ASSETS) {
      const destination = join(target, name);
      if ((await lstat(destination).catch(() => null))?.isDirectory()) {
        io.stderr(`selfhost-kit: ${destination} is a directory`);
        return 1;
      }
    }
    for (const { name, mode } of DOCKER_ASSETS) {
      const destination = join(target, name);
      // Remove what's there first, so a symlink is replaced rather than written through, and copy
      // exclusively, so nothing put back in between is followed either. copyFile follows the source's
      // symlinks, so the copy is always a regular file with the asset's bytes.
      await rm(destination, { force: true });
      await copyFile(join(sourceDir, name), destination, constants.COPYFILE_EXCL);
      await chmod(destination, mode);
      io.stdout(`copied ${name}`);
    }
  } catch (error) {
    io.stderr(`selfhost-kit: ${(error as Error).message}`);
    return 1;
  }
  return 0;
}
