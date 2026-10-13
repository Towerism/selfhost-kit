import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const env = {
    ...process.env,
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

/** A fresh ESM project with the tarball installed offline, and nothing else. */
export async function makeConsumer(kit: PackedKit, name: string): Promise<Consumer> {
  const dir = join(kit.dir, name);
  await mkdir(dir);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }));
  await run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', kit.tarball], {
    cwd: dir,
    env: kit.env,
  });

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
            types: [],
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
