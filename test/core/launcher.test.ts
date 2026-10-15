import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidConfigError } from '../../src/core/runtime/env.js';
import { type LauncherProcess, launch } from '../../src/core/runtime/launcher.js';
import { InvalidSecretError } from '../../src/core/secrets/index.js';
import type { Logger } from '../../src/core/logging/types.js';
import { tempSecretsDir, type TempSecretsDir } from '../../src/testing/secrets.js';
import { runModule } from '../helpers/child.js';

declare global {
  var launchEvents: string[] | undefined;
}

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${String(code)}`);
  }
}

let importCount = 0;
/** A fresh URL each time, so the stub server module runs again instead of coming from the module cache. */
const stubServer = () =>
  new URL(`../fixtures/launcher/server.mjs?n=${String(++importCount)}`, import.meta.url);
const brokenServer = () =>
  new URL(`../fixtures/launcher/broken-server.mjs?n=${String(++importCount)}`, import.meta.url);

function fakeProcess(env: Record<string, string>): LauncherProcess & { exitCodes: number[] } {
  const exitCodes: number[] = [];
  return {
    env,
    exitCodes,
    exit: (code: number) => {
      exitCodes.push(code);
      throw new Exit(code);
    },
  };
}

function recordingLogger(): Logger {
  const record = (level: string) => (msg: string) => {
    globalThis.launchEvents?.push(`${level}: ${msg}`);
  };
  const logger: Logger = {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    child: () => logger,
  };
  return logger;
}

beforeEach(() => {
  globalThis.launchEvents = [];
});
afterEach(() => {
  globalThis.launchEvents = undefined;
});

describe('launch', () => {
  it('replaces the env with the prepared one and logs the lines, then imports the server', async () => {
    const proc = fakeProcess({ KEEP: 'k', DROP: 'd', CHANGE: 'old' });
    await launch(
      {
        prepare: (env) => ({
          env: { KEEP: env.KEEP, CHANGE: 'new', ADDED: 'a', UNSET: undefined },
          log: ['one', 'two'],
        }),
        server: stubServer(),
        logger: recordingLogger(),
      },
      proc,
    );

    expect(proc.env).toEqual({ KEEP: 'k', CHANGE: 'new', ADDED: 'a' });
    expect(globalThis.launchEvents).toEqual(['info: one', 'info: two', 'server imported']);
    expect(proc.exitCodes).toEqual([]);
  });

  // A logger the launcher built itself would redact only the base keys, never the app's own.
  it("refuses to start without the app's logger, before prepare runs or the server loads", async () => {
    const proc = fakeProcess({ KEEP: 'k' });
    let prepared = false;
    const opts = {
      prepare: () => {
        prepared = true;
        return { env: {}, log: [] };
      },
      server: stubServer(),
    };
    // @ts-expect-error -- the logger is required
    const run = launch(opts, proc);
    await expect(run).rejects.toThrow(new TypeError("runLauncher needs a logger: pass the app's logger"));
    expect(prepared).toBe(false);
    expect(globalThis.launchEvents).toEqual([]);
    expect(proc.env).toEqual({ KEEP: 'k' });
  });

  it.each([
    [
      'an invalid secret',
      new InvalidSecretError('Invalid secret in env var NUXT_X: must be at least 32 characters.'),
    ],
    [
      'invalid config',
      new InvalidConfigError('NUXT_TUNING must be a whole number of at least 1 (got "abc").'),
    ],
  ])('on %s, logs the message, exits with 1 and never imports the server', async (_label, error) => {
    const proc = fakeProcess({ KEEP: 'k' });
    const run = launch(
      {
        prepare: () => {
          throw error;
        },
        server: stubServer(),
        logger: recordingLogger(),
      },
      proc,
    );

    await expect(run).rejects.toBeInstanceOf(Exit);
    expect(proc.exitCodes).toEqual([1]);
    expect(globalThis.launchEvents).toEqual([`error: ${error.message}`]);
    expect(proc.env).toEqual({ KEEP: 'k' });
  });

  it('lets any other error through unchanged, without exiting or importing the server', async () => {
    const bug = new TypeError('a bug in prepare');
    const proc = fakeProcess({});
    const run = launch(
      {
        prepare: () => {
          throw bug;
        },
        server: stubServer(),
        logger: recordingLogger(),
      },
      proc,
    );

    await expect(run).rejects.toBe(bug);
    expect(proc.exitCodes).toEqual([]);
    expect(globalThis.launchEvents).toEqual([]);
  });

  it("lets the server's own import error through", async () => {
    const proc = fakeProcess({});
    const run = launch(
      { prepare: () => ({ env: {}, log: [] }), server: brokenServer(), logger: recordingLogger() },
      proc,
    );
    await expect(run).rejects.toThrow('the server failed to load');
  });
});

describe('runLauncher in a real process', () => {
  const launcher = fileURLToPath(new URL('../fixtures/launcher/launcher.mjs', import.meta.url));
  let data: TempSecretsDir;
  beforeEach(() => {
    data = tempSecretsDir();
  });
  afterEach(() => {
    data.cleanup();
  });

  it('sets the prepared env before the server is imported, and logs the startup lines first', async () => {
    const result = await runModule({
      file: launcher,
      env: {
        NUXT_DATABASE_PATH: data.databasePath,
        NUXT_TUNING: ' ',
        PRINT_ENV: '1',
        NUXT_LOG_FORMAT: 'json',
        TZ: 'UTC',
      },
    });

    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 30,
      scope: 'startup',
      msg: expect.stringMatching(/^Vault key: generated into /) as unknown,
    });
    const seen = JSON.parse(lines[1]!.replace(/^SERVER /, '')) as Record<string, string>;
    expect(Buffer.from(seen.NUXT_APP_VAULT_KEY!, 'base64')).toHaveLength(32);
    expect(seen.NUXT_SESSION_COOKIE_SECURE).toBe('false');
    expect(seen).not.toHaveProperty('NUXT_TUNING');
  });

  it('exits with 1 on invalid config, printing the error and never loading the server', async () => {
    const result = await runModule({
      file: launcher,
      env: { SCENARIO: 'invalid-config', PRINT_ENV: '1', NUXT_LOG_FORMAT: 'json' },
    });

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      level: 50,
      scope: 'startup',
      msg: 'NUXT_TUNING must be a whole number of at least 1 (got "abc").',
    });
    expect(result.stdout).not.toContain('SERVER');
  });

  it('dies with the stack on any other error, never loading the server', async () => {
    const result = await runModule({ file: launcher, env: { SCENARIO: 'plain-error', PRINT_ENV: '1' } });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Error: a bug in prepare');
    expect(result.stderr).toMatch(/\n\s+at /);
    expect(result.stdout).not.toContain('SERVER');
  });

  it('dies when the server fails to load', async () => {
    const result = await runModule({
      file: launcher,
      env: { NUXT_DATABASE_PATH: data.databasePath, BROKEN_SERVER: '1', NUXT_LOG_LEVEL: 'silent' },
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('the server failed to load');
  });
});
