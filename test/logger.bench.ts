// `pnpm bench`: logger throughput, run by hand and reported in PRs that touch logging. Not a gate, because
// wall-clock budgets flake on shared CI runners. Budgets per 10,000-record run: JSON under 1 s, readable
// lines under 2.5 s.
import { test } from 'vitest';
import { createLogger } from '../src/core/logging/logger.js';

// 50 keys, 5 of them secret, nested two levels down.
function record(i: number): Record<string, unknown> {
  const inner: Record<string, unknown> = {};
  for (let k = 0; k < 45; k++) inner[`field${String(k)}`] = `value-${String(i)}-${String(k)}`;
  Object.assign(inner, { token: 't', password: 'p', cookie: 'c', refresh_token: 'r', dob: 'd' });
  return { outer: { inner } };
}

function tenThousand(format: 'json' | 'pretty') {
  let bytes = 0;
  const log = createLogger({
    scope: 'bench',
    level: 'info',
    format,
    destination: { write: (line: string) => (bytes += line.length) },
  });
  return () => {
    for (let i = 0; i < 10_000; i++) log.info('record', record(i));
    if (bytes === 0) throw new Error('nothing was written');
  };
}

test('logger: 10,000 nested records with 5 secrets each', async ({ bench }) => {
  const results = await bench.compare(
    bench('as JSON (budget 1,000 ms)', tenThousand('json')),
    bench('as readable lines (budget 2,500 ms)', tenThousand('pretty')),
    { iterations: 5, warmupIterations: 1 },
  );
  for (const name of ['as JSON (budget 1,000 ms)', 'as readable lines (budget 2,500 ms)'] as const) {
    console.log(`${name}: mean ${results.get(name).latency.mean.toFixed(0)} ms per 10,000 records`);
  }
});
