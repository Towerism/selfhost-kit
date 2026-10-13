import type { LogDestination } from '../../src/core/logging/logger.js';

/** A log destination that keeps every line it is given, to read back what the logger wrote. */
export function memoryDestination(isTTY = false) {
  const lines: string[] = [];
  const destination: LogDestination = {
    write: (line: string) => void lines.push(line),
    isTTY,
  };
  return {
    lines,
    destination,
    text: () => lines.join(''),
    records: () =>
      lines
        .join('')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}
