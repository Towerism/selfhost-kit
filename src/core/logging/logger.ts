/**
 * The app's logger: pino to stdout, readable by default so the operator can follow it in Unraid's log
 * viewer, JSON on request (`NUXT_LOG_FORMAT=json`). Every record is redacted before it is formatted.
 *
 * Plain TS: the launcher uses it before Nitro loads.
 */
import pino from 'pino';
import { prettyFactory } from 'pino-pretty';
import type { Redactor } from './redact.js';
import type { LogFields, Logger } from './types.js';

export { type LogFields, type Logger, silentLogger } from './types.js';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type LogFormat = 'pretty' | 'json';

/** Where lines go (default `process.stdout`). Colour is used only when `isTTY` is true and `NO_COLOR` is unset. */
export interface LogDestination {
  write(line: string): unknown;
  isTTY?: boolean;
}

export interface CreateLoggerOptions {
  scope: string;
  /** The app's redactor, with its extra keys. Required: a default would hide only the base keys. */
  redactor: Redactor;
  /** Defaults to `NUXT_LOG_LEVEL` (read case-insensitively). An unknown value → `info`, with a warning. */
  level?: LogLevel;
  /** Defaults to `NUXT_LOG_FORMAT` (read case-insensitively). An unknown value → `pretty`, with a warning. */
  format?: LogFormat;
  /** Called per record; its fields (the request id) are merged in. */
  context?: () => Record<string, unknown> | undefined;
  destination?: LogDestination;
}

const LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const FORMATS: readonly LogFormat[] = ['pretty', 'json'];
// Shown in the line's prefix, so not repeated after the message; an http line also shows these in its message.
const HIDDEN = new Set(['time', 'level']);
const HIDDEN_HTTP = new Set([...HIDDEN, 'method', 'path', 'status', 'durationMs']);

/**
 * A logger that never throws to its caller: a failing context provider, field or destination is swallowed.
 *
 * - `json`: one object per line with numeric `level`, `time`, `scope`, `msg` and the fields.
 * - `pretty`: `[YYYY-MM-DD HH:mm:ss.SSS] LEVEL: [scope] msg {fields}` in local time, then an error's stack
 *   indented by 4 spaces. These line formats are public API (ADR-0005).
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  // Checked at runtime too: an untyped caller must not silently get a logger that hides only the base keys.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!options.redactor) {
    throw new TypeError(
      "createLogger needs a redactor: pass createRedactor({ extraKeys }) with the app's keys",
    );
  }
  const { redactor } = options;
  const warnings: string[] = [];
  const level = pick(LEVELS, 'info', options.level ?? process.env.NUXT_LOG_LEVEL, 'NUXT_LOG_LEVEL', warnings);
  const format = pick(
    FORMATS,
    'pretty',
    options.format ?? process.env.NUXT_LOG_FORMAT,
    'NUXT_LOG_FORMAT',
    warnings,
  );
  const destination = options.destination ?? process.stdout;

  const toText = format === 'json' ? (line: string) => line : prettyLine(destination);
  const stream = {
    write(line: string) {
      try {
        destination.write(toText(line));
      } catch {
        // A closed pipe or a slow log driver must never take the app down.
      }
    },
  };
  const root = pino(
    {
      level,
      base: null,
      formatters: { level: (_label, number) => ({ level: number }) },
      // Errors arrive already redacted as plain objects.
      serializers: { err: (err: unknown) => err },
    },
    stream,
  );

  const log = wrap(root, redactor, { scope: options.scope }, options.context);
  for (const warning of warnings) log.warn(warning);
  return log;
}

function wrap(
  root: pino.Logger,
  redactor: Redactor,
  bindings: Record<string, unknown>,
  context: CreateLoggerOptions['context'],
): Logger {
  const target = root.child(redactor.redact(bindings) as Record<string, unknown>);
  const emit = (level: 'error' | 'warn' | 'info' | 'debug') => (msg: string, fields?: LogFields) => {
    if (!target.isLevelEnabled(level)) return;
    try {
      const record = redactor.redact({ ...contextOf(context), ...fields }) as Record<string, unknown>;
      target[level](record, redactor.scrub(msg));
    } catch {
      // Logging never fails the caller (a fields object whose getter throws, for one).
    }
  };
  return {
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    child: (scope, more) => wrap(root, redactor, { ...bindings, ...more, scope }, context),
  };
}

function contextOf(context: CreateLoggerOptions['context']): Record<string, unknown> | undefined {
  try {
    return context?.();
  } catch {
    return undefined;
  }
}

function pick<T extends string>(
  allowed: readonly T[],
  fallback: T,
  raw: string | undefined,
  name: string,
  warnings: string[],
): T {
  if (raw === undefined || raw === '') return fallback;
  const value = raw.toLowerCase() as T;
  if (allowed.includes(value)) return value;
  warnings.push(`${name} "${raw}" is not one of ${allowed.join(', ')}; using ${fallback}.`);
  return fallback;
}

/**
 * `[YYYY-MM-DD HH:mm:ss.SSS] LEVEL: [scope] msg {fields}`, then the error's stack indented by 4 spaces.
 * Newlines in the message are escaped so a record stays on its own line.
 */
function prettyLine(destination: LogDestination): (line: string) => string {
  const prettify = prettyFactory({
    colorize: destination.isTTY === true && !process.env.NO_COLOR,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    ignore: 'pid,hostname',
    hideObject: true,
    singleLine: true,
    messageFormat: (record: Record<string, unknown>) => {
      const { msg, scope, err, ...fields } = record;
      const hidden = scope === 'http' ? HIDDEN_HTTP : HIDDEN;
      const rest = Object.fromEntries(Object.entries(fields).filter(([k]) => !hidden.has(k)));
      let text = `[${String(scope)}] ${String(msg).replace(/\r?\n|\r/g, '\\n')}`;
      if (Object.keys(rest).length > 0) text += ` ${JSON.stringify(rest)}`;
      if (err) text += `\n${indent(stackOf(err))}`;
      return text;
    },
  });
  return (line) => `${prettify(line).trimEnd()}\n`;
}

function stackOf(err: unknown): string {
  const e = err as { stack?: unknown; type?: unknown; message?: unknown };
  if (typeof e.stack === 'string') return e.stack;
  return `${typeof e.type === 'string' ? e.type : 'Error'}: ${typeof e.message === 'string' ? e.message : ''}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line.trimStart()}`)
    .join('\n');
}
