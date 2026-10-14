import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCalls, runShell, stubBin, toolbox } from '../helpers/shell.js';

// fetch-litestream.sh's refusals, offline. Its happy path (a real download that matches the pin) runs
// in the fixture image's build (test/entrypoint/Dockerfile).
const SCRIPT = fileURLToPath(new URL('../../docker/fetch-litestream.sh', import.meta.url));
const TOOLS = ['mkdir', 'mktemp', 'rm', 'sha256sum', 'tar', 'chmod', 'mv'];

let dir: string;
let bin: string;
let dest: string;
let log: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'selfhost-kit-fetch-'));
  bin = await toolbox(join(dir, 'bin'), TOOLS);
  dest = join(dir, 'dest');
  log = join(dir, 'calls.jsonl');
  await mkdir(join(dir, 'tmp'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fakeUname(machine: string) {
  const path = join(bin, 'uname');
  await writeFile(path, `#!/bin/sh\necho ${machine}\n`);
  await chmod(path, 0o755);
}

function run(env: Record<string, string> = {}, args: string[] = [dest]) {
  return runShell(SCRIPT, args, {
    PATH: bin,
    STUB_LOG: log,
    TMPDIR: join(dir, 'tmp'),
    TARGETARCH: 'amd64',
    ...env,
  });
}

async function expectNothingInstalled() {
  expect(existsSync(join(dest, 'litestream'))).toBe(false);
  // The download's temp dir is removed too.
  expect(await readdir(join(dir, 'tmp'))).toEqual([]);
}

describe('fetch-litestream.sh', () => {
  it.each(['wget', 'curl'])(
    'refuses an archive whose checksum differs from the pin (%s)',
    async (downloader) => {
      await stubBin(bin, downloader, 'serve');
      const result = await run({ STUB_BYTES: 'not the litestream archive' });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(
        /^\[fetch-litestream\] checksum mismatch for litestream-0\.5\.17-linux-x86_64\.tar\.gz \(expected [0-9a-f]{64}\)\n$/,
      );
      const [call] = await readCalls(log);
      expect(call!.tool).toBe(downloader);
      expect(call!.argv.at(-1)).toBe(
        'https://github.com/benbjohnson/litestream/releases/download/v0.5.17/litestream-0.5.17-linux-x86_64.tar.gz',
      );
      await expectNothingInstalled();
    },
  );

  it('prefers wget when both downloaders exist', async () => {
    await stubBin(bin, 'wget', 'serve');
    await stubBin(bin, 'curl', 'serve');
    await run();
    expect((await readCalls(log)).map((c) => c.tool)).toEqual(['wget']);
  });

  it('stops when the download fails', async () => {
    await stubBin(bin, 'wget', 'serve');
    const result = await run({ STUB_DOWNLOAD_STATUS: '8' });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^\[fetch-litestream\] download failed: https:\/\/github\.com\/.+\n$/);
    await expectNothingInstalled();
  });

  it.each([
    [{ TARGETARCH: 'arm64' }, 'arm64'],
    [{ TARGETARCH: '' }, 'aarch64'],
  ])('refuses any architecture but amd64: %o', async (env, got) => {
    await fakeUname('aarch64');
    await stubBin(bin, 'wget', 'serve');
    const result = await run(env);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`[fetch-litestream] Litestream is pinned for linux/amd64 only (got ${got})\n`);
    expect(await readCalls(log)).toEqual([]);
    await expectNothingInstalled();
  });

  it('accepts x86_64 from uname when TARGETARCH is unset', async () => {
    await fakeUname('x86_64');
    await stubBin(bin, 'wget', 'serve');
    const result = await run({ TARGETARCH: '' });
    expect(result.stderr).toContain('checksum mismatch');
  });

  it('needs wget or curl', async () => {
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('[fetch-litestream] neither wget nor curl is installed\n');
    await expectNothingInstalled();
  });

  it.each([[[]], [['']], [['a', 'b']]])('needs exactly one destination directory: %j', async (args) => {
    const result = await run({}, args);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('[fetch-litestream] usage: fetch-litestream.sh <dest-dir>\n');
  });

  it("pins one version and checksum where Renovate's regex manager sees them", async () => {
    const renovate = JSON.parse(await readFile(new URL('../../renovate.json', import.meta.url), 'utf8')) as {
      customManagers: { managerFilePatterns: string[]; matchStrings: string[] }[];
    };
    const text = await readFile(SCRIPT, 'utf8');
    const managers = renovate.customManagers.filter((m) =>
      m.managerFilePatterns.some((p) => new RegExp(p.slice(1, -1)).test('docker/fetch-litestream.sh')),
    );
    const captured = managers.flatMap((m) =>
      m.matchStrings.flatMap((source) =>
        [...text.matchAll(new RegExp(source, 'g'))].map((match) => match.groups),
      ),
    );
    expect(captured).toEqual([
      {
        datasource: 'github-release-attachments',
        depName: 'benbjohnson/litestream',
        currentValue: 'v0.5.17',
        currentDigest: 'cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d',
      },
    ]);
  });
});
