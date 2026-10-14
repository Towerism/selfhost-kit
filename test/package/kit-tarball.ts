import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export interface PackedKit {
  dir: string;
  tarball: string;
  files: string[];
  /** npm's cache and user config live inside dir, so nothing is shared with the machine or other tests. */
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

/** Packs the built package with npm, the same tool @semantic-release/npm publishes with. */
export async function packKit(): Promise<PackedKit> {
  if (!existsSync(join(repoRoot, 'dist/core/index.js'))) {
    throw new Error('dist/ is missing: run `pnpm build` before `pnpm test:package`');
  }
  const dir = await mkdtemp(join(tmpdir(), 'selfhost-kit-pack-'));
  const userconfig = join(dir, 'npmrc');
  await writeFile(userconfig, '');
  // pnpm sets NODE_PATH for scripts; passed on, it would let a consumer resolve the repo's whole tree.
  const inherited = { ...process.env };
  Reflect.deleteProperty(inherited, 'NODE_PATH');
  const env = {
    ...inherited,
    npm_config_cache: join(dir, 'npm-cache'),
    npm_config_userconfig: userconfig,
    npm_config_update_notifier: 'false',
  };

  const { stdout } = await run('npm', ['pack', '--json', '--pack-destination', dir], { cwd: repoRoot, env });
  const [result] = JSON.parse(stdout) as [{ filename: string; files: { path: string }[] }];

  return {
    dir,
    tarball: join(dir, result.filename),
    files: result.files.map((f) => f.path).sort(),
    env,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export interface Consumer {
  dir: string;
  /** Runs an ES module snippet in the consumer project and returns its stdout. */
  node: (source: string) => Promise<string>;
  tsc: (moduleResolution: 'NodeNext' | 'Bundler') => Promise<void>;
}

/**
 * A fresh ESM project with the tarball installed the way a package manager lays it out, offline and with no
 * package-manager cache: the tarball is unpacked into `node_modules/@towerism/selfhost-kit`, and exactly its
 * declared `dependencies` (plus any `peers` asked for) are linked to the copies this repo already installed.
 * Anything the built code imports without declaring it fails to resolve.
 */
export async function makeConsumer(kit: PackedKit, name: string, peers: string[] = []): Promise<Consumer> {
  const dir = join(kit.dir, name);
  const scope = join(dir, 'node_modules', '@towerism');
  await mkdir(scope, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }));
  await run('tar', ['-xzf', kit.tarball, '-C', scope]);
  await rename(join(scope, 'package'), join(scope, 'selfhost-kit'));

  const manifest = JSON.parse(await readFile(join(scope, 'selfhost-kit', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...peers]) {
    const target = join(dir, 'node_modules', dependency);
    await mkdir(dirname(target), { recursive: true });
    await symlink(await realpath(join(repoRoot, 'node_modules', dependency)), target);
  }

  return {
    dir,
    node: async (source) =>
      (await run(process.execPath, ['--input-type=module', '--eval', source], { cwd: dir, env: kit.env }))
        .stdout,
    tsc: async (moduleResolution) => {
      const config = `tsconfig.${moduleResolution}.json`;
      await writeFile(
        join(dir, config),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2023',
            module: moduleResolution === 'NodeNext' ? 'NodeNext' : 'ESNext',
            moduleResolution,
            strict: true,
            noEmit: true,
            // Nitro's server tsconfig: h3's declarations refer to the WebWorker `FetchEvent`.
            lib: ['ES2023', 'WebWorker', 'DOM.Iterable'],
            // Every consumer is a Node app: the vault's API is in Buffers.
            types: ['node'],
          },
          files: ['consumer.ts'],
        }),
      );
      await run(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', config], {
        cwd: dir,
      });
    },
  };
}
