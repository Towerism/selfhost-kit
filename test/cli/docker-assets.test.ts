import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOCKER_ASSETS, runCli } from '../../src/cli/index.js';

const USAGE = 'Usage: selfhost-kit docker-assets <dir>';

let dir: string;
let assets: string;
let out: string[];
let err: string[];
const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'selfhost-kit-cli-'));
  // pnpm reaches a package through a symlink: node_modules/@towerism/selfhost-kit -> .pnpm/…
  const real = join(dir, 'store', 'selfhost-kit', 'docker');
  await mkdir(real, { recursive: true });
  for (const { name } of DOCKER_ASSETS)
    await writeFile(join(real, name), `contents of ${name}\n`, { mode: 0o600 });
  await mkdir(join(dir, 'node_modules'));
  await symlink(join(dir, 'store', 'selfhost-kit'), join(dir, 'node_modules', 'selfhost-kit'));
  assets = join(dir, 'node_modules', 'selfhost-kit', 'docker');
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('selfhost-kit docker-assets', () => {
  it('copies the three assets as regular files with their modes', async () => {
    const target = join(dir, '.output', 'selfhost kit');
    expect(await runCli(['docker-assets', target], io, { assetsDir: assets })).toBe(0);
    expect(out).toEqual(['copied entrypoint.sh', 'copied fetch-litestream.sh', 'copied litestream.yml']);
    expect(err).toEqual([]);
    for (const [name, mode] of [
      ['entrypoint.sh', 0o755],
      ['fetch-litestream.sh', 0o755],
      ['litestream.yml', 0o644],
    ] as const) {
      const info = await lstat(join(target, name));
      expect(info.isFile()).toBe(true);
      expect(info.isSymbolicLink()).toBe(false);
      expect(info.mode & 0o777).toBe(mode);
      expect(await readFile(join(target, name), 'utf8')).toBe(`contents of ${name}\n`);
    }
  });

  it('overwrites what an earlier run copied', async () => {
    const target = join(dir, 'out');
    await runCli(['docker-assets', target], io, { assetsDir: assets });
    await writeFile(join(target, 'entrypoint.sh'), 'stale');
    await writeFile(join(dir, 'store', 'selfhost-kit', 'docker', 'litestream.yml'), 'updated\n');
    expect(await runCli(['docker-assets', target], io, { assetsDir: assets })).toBe(0);
    expect(await readFile(join(target, 'entrypoint.sh'), 'utf8')).toBe('contents of entrypoint.sh\n');
    expect(await readFile(join(target, 'litestream.yml'), 'utf8')).toBe('updated\n');
  });

  it('copies from the package it belongs to by default', async () => {
    const target = join(dir, 'out');
    expect(await runCli(['docker-assets', target], io)).toBe(0);
    const shipped = await readFile(new URL('../../docker/entrypoint.sh', import.meta.url), 'utf8');
    expect(await readFile(join(target, 'entrypoint.sh'), 'utf8')).toBe(shipped);
    expect((await stat(join(target, 'entrypoint.sh'))).mode & 0o777).toBe(0o755);
  });

  it.each([
    [[]],
    [['docker-assets']],
    [['docker-assets', '']],
    [['docker-assets', 'a', 'b']],
    [['copy', 'x']],
  ])('prints usage and returns 2 for %j', async (argv) => {
    expect(await runCli(argv, io, { assetsDir: assets })).toBe(2);
    expect(err).toEqual([USAGE]);
    expect(out).toEqual([]);
  });

  it.each(['--help', '-h'])('prints usage on stdout for %s', async (flag) => {
    expect(await runCli([flag], io)).toBe(0);
    expect(out).toEqual([USAGE]);
    expect(err).toEqual([]);
  });

  it.each([
    [['docker-assets', '--help']],
    [['docker-assets', 'out', '-h']],
    [['-h', 'docker-assets', 'out']],
    [['docker-assets', '-x', '--help']],
  ])('treats help anywhere in %j as help, creating nothing', async (argv) => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await runCli(argv, io, { assetsDir: assets })).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(out).toEqual([USAGE]);
    expect(err).toEqual([]);
    for (const name of ['out', '--help', '-x']) expect(existsSync(join(dir, name))).toBe(false);
  });

  it.each(['-x', '--output'])('refuses a <dir> that looks like an option: %s', async (target) => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await runCli(['docker-assets', target], io, { assetsDir: assets })).toBe(2);
    } finally {
      process.chdir(cwd);
    }
    expect(err).toEqual([USAGE]);
    expect(out).toEqual([]);
    expect(existsSync(join(dir, target))).toBe(false);
  });

  it('returns 1 with the reason when the target cannot be written', async () => {
    const file = join(dir, 'a-file');
    await writeFile(file, '');
    expect(await runCli(['docker-assets', file], io, { assetsDir: assets })).toBe(1);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^selfhost-kit: .*(EEXIST|ENOTDIR)/);
  });

  describe('when a destination already exists as something else', () => {
    let target: string;
    let outside: string;
    beforeEach(async () => {
      target = join(dir, 'out');
      outside = join(dir, 'outside');
      await mkdir(target);
      await writeFile(outside, 'outside', { mode: 0o600 });
    });

    it('replaces a symlink with a regular file and leaves its target alone', async () => {
      await symlink(outside, join(target, 'entrypoint.sh'));
      expect(await runCli(['docker-assets', target], io, { assetsDir: assets })).toBe(0);
      const info = await lstat(join(target, 'entrypoint.sh'));
      expect(info.isFile()).toBe(true);
      expect(info.mode & 0o777).toBe(0o755);
      expect(await readFile(join(target, 'entrypoint.sh'), 'utf8')).toBe('contents of entrypoint.sh\n');
      expect(await readFile(outside, 'utf8')).toBe('outside');
      expect((await stat(outside)).mode & 0o777).toBe(0o600);
    });

    it('replaces a dangling symlink without creating what it pointed at', async () => {
      const missing = join(dir, 'missing');
      await symlink(missing, join(target, 'litestream.yml'));
      expect(await runCli(['docker-assets', target], io, { assetsDir: assets })).toBe(0);
      const info = await lstat(join(target, 'litestream.yml'));
      expect(info.isFile()).toBe(true);
      expect(info.mode & 0o777).toBe(0o644);
      expect(existsSync(missing)).toBe(false);
    });

    it('refuses a directory before copying anything', async () => {
      await writeFile(join(target, 'entrypoint.sh'), 'old');
      await mkdir(join(target, 'litestream.yml'));
      await writeFile(join(target, 'litestream.yml', 'keep'), 'keep');
      expect(await runCli(['docker-assets', target], io, { assetsDir: assets })).toBe(1);
      expect(err).toEqual([`selfhost-kit: ${join(target, 'litestream.yml')} is a directory`]);
      expect(out).toEqual([]);
      expect(await readFile(join(target, 'litestream.yml', 'keep'), 'utf8')).toBe('keep');
      expect(await readFile(join(target, 'entrypoint.sh'), 'utf8')).toBe('old');
      expect(existsSync(join(target, 'fetch-litestream.sh'))).toBe(false);
    });
  });

  it('returns 1 when an asset is missing from the package', async () => {
    await rm(join(dir, 'store', 'selfhost-kit', 'docker', 'litestream.yml'));
    expect(await runCli(['docker-assets', join(dir, 'out')], io, { assetsDir: assets })).toBe(1);
    expect(err[0]).toMatch(/^selfhost-kit: .*ENOENT/);
  });

  it.each([
    ['stdout', ['--help'], 0],
    ['stderr', ['nope'], 2],
  ] as const)('writes to process.%s when no io is given', async (name, argv, code) => {
    const stream = process[name];
    const lines: string[] = [];
    const write = stream.write.bind(stream);
    stream.write = (chunk: string) => lines.push(chunk) > 0;
    try {
      expect(await runCli(argv)).toBe(code);
    } finally {
      stream.write = write;
    }
    expect(lines).toEqual([`${USAGE}\n`]);
  });
});
