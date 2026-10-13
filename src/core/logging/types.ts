/**
 * The logger port. Domain modules depend on this (never on pino or `createLogger`) and receive a `Logger`
 * from the app's wiring.
 */
export type LogFields = Record<string, unknown> & { err?: unknown };

export interface Logger {
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  /** A logger whose records carry `scope` and `bindings`, with the same destination and redaction. */
  child(scope: string, bindings?: Record<string, unknown>): Logger;
}

/** For code built without a logger (unit tests): accepts everything, writes nothing. */
export const silentLogger: Logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  child: () => silentLogger,
};
