import { createLogger } from '../logging/logger.js';
import type { Logger } from '../logging/types.js';
import { type Env, InvalidSecretError } from '../secrets/index.js';
import { InvalidConfigError, type PreparedEnv } from './env.js';

export interface LauncherOptions {
  /** Works out the server's env from the process env, usually with `prepareRuntimeEnv`. */
  prepare: (env: Env) => PreparedEnv;
  /** The server entry to import once the env is in place (Nitro's `server/index.mjs`). */
  server: URL;
  /** Default `createLogger({ scope: 'startup' })`. */
  logger?: Logger;
}

/** The parts of `process` the launcher touches. */
export interface LauncherProcess {
  env: Env;
  exit(code: number): void;
}

/**
 * The launcher's logic, over a process-like object so it can be tested in-process. Apps use
 * {@link runLauncher}.
 */
export async function launch(opts: LauncherOptions, proc: LauncherProcess = process): Promise<void> {
  const logger = opts.logger ?? createLogger({ scope: 'startup' });
  let prepared: PreparedEnv;
  try {
    prepared = opts.prepare(proc.env);
  } catch (err) {
    if (!(err instanceof InvalidSecretError) && !(err instanceof InvalidConfigError)) throw err;
    logger.error(err.message);
    proc.exit(1);
    return;
  }

  for (const name of Object.keys(proc.env)) {
    if (prepared.env[name] === undefined) Reflect.deleteProperty(proc.env, name);
  }
  for (const [name, value] of Object.entries(prepared.env)) {
    if (value !== undefined) proc.env[name] = value;
  }
  for (const line of prepared.log) logger.info(line);

  await import(opts.server.href);
}

/**
 * The production entry point. Nitro reads its runtime config from env once, at import, so this resolves
 * the env *before* the server loads: it calls `prepare(process.env)`, makes `process.env` exactly the
 * prepared env, logs the startup lines, then imports `server`.
 *
 * On `InvalidSecretError` or `InvalidConfigError` it logs the message and exits with code 1 without
 * importing the server. Any other error propagates, so the process dies with its stack.
 */
export const runLauncher: (opts: LauncherOptions) => Promise<void> = launch;
