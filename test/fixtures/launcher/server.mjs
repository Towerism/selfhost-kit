// Stands in for Nitro's server entry: records that it was imported, and what env it saw at import time.
globalThis.launchEvents?.push('server imported');
if (process.env.PRINT_ENV === '1') {
  process.stdout.write(`SERVER ${JSON.stringify(process.env)}\n`);
}
