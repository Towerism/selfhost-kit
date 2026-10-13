import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkNpm,
  MINIMUM_NPM_VERSION,
  supportsTrustedPublishing,
} from '../scripts/check-npm-trusted-publishing.mjs';

const script = fileURLToPath(new URL('../scripts/check-npm-trusted-publishing.mjs', import.meta.url));
const run = promisify(execFile);

describe('supportsTrustedPublishing', () => {
  it('needs npm 11.5.1, the first npm that does the OIDC exchange itself', () => {
    expect(MINIMUM_NPM_VERSION).toBe('11.5.1');
  });

  it.each(['11.5.1', '11.19.0', '12.0.0', '11.6.0', ' 11.5.1\n'])('accepts %j', (version) => {
    expect(supportsTrustedPublishing(version)).toBe(true);
  });

  it.each(['10.9.9', '11.4.2', '11.5.0', '11.5.1-pre.0', '', 'not-a-version', '11.5', 'v11.5.1'])(
    'rejects %j',
    (version) => {
      expect(supportsTrustedPublishing(version)).toBe(false);
    },
  );
});

// A fake npm on PATH stands in for the real one: no real npm, no network, no mocks.
describe('the release check', () => {
  let bin: string | undefined;

  afterEach(async () => {
    if (bin) await rm(bin, { recursive: true, force: true });
    bin = undefined;
  });

  async function binDir(npmBody?: string): Promise<string> {
    bin = await mkdtemp(join(tmpdir(), 'fake-npm-'));
    if (npmBody !== undefined) {
      const npm = join(bin, 'npm');
      await writeFile(npm, `#!/bin/sh\n${npmBody}\n`);
      await chmod(npm, 0o755);
    }
    return bin;
  }

  async function runScript(path: string) {
    try {
      const { stdout, stderr } = await run(process.execPath, [script], { env: { PATH: path } });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
      return { code, stdout, stderr };
    }
  }

  it('fails on an npm too old for trusted publishing, naming both versions', async () => {
    expect(checkNpm({ PATH: await binDir('echo 10.9.9') })).toEqual({
      ok: false,
      message: "npm 10.9.9 can't publish with OIDC: trusted publishing needs npm >= 11.5.1",
    });
  });

  it('passes on an npm that supports trusted publishing', async () => {
    expect(checkNpm({ PATH: await binDir('echo 11.19.0') })).toEqual({
      ok: true,
      message: 'npm 11.19.0 supports trusted publishing',
    });
  });

  it('fails closed when npm exits non-zero', async () => {
    const result = checkNpm({ PATH: await binDir('echo boom >&2; exit 3') });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^couldn't read the npm version: /);
  });

  it('fails closed when npm is not on PATH', async () => {
    const result = checkNpm({ PATH: await binDir() });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^couldn't read the npm version: /);
  });

  it('as a script, exits 1 and reports on stderr when npm is too old', async () => {
    expect(await runScript(await binDir('echo 10.9.9'))).toEqual({
      code: 1,
      stdout: '',
      stderr: "npm 10.9.9 can't publish with OIDC: trusted publishing needs npm >= 11.5.1\n",
    });
  });

  it('as a script, exits 0 and reports on stdout when npm is new enough', async () => {
    expect(await runScript(await binDir('echo 11.19.0'))).toEqual({
      code: 0,
      stdout: 'npm 11.19.0 supports trusted publishing\n',
      stderr: '',
    });
  });
});
