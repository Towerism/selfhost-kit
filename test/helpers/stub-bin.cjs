// The stub binaries' logic (test/helpers/shell.ts). Each stub on disk is a two-line sh wrapper:
//
//   exec '<node>' '<this file>' '<name>' '<behaviour>' "$@"
//
// It appends a JSON line describing its call to $STUB_LOG, then does what <behaviour> says. Stubs
// record what they were asked; the outcome comes from the script under test or the env the test sets.
'use strict';
const { appendFileSync, writeFileSync } = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');

const [name = '', behaviour = '', ...argv] = process.argv.slice(2);
/** The argument after `flag`, or '' when there is none. */
const after = (/** @type {string} */ flag) => argv[argv.indexOf(flag) + 1] ?? '';

/** @type {import('./shell.js').StubCall} */
const call = {
  tool: name,
  argv,
  env: {
    LITESTREAM_REPLICA_URL: process.env.LITESTREAM_REPLICA_URL,
    NUXT_DATABASE_PATH: process.env.NUXT_DATABASE_PATH,
  },
};

if (behaviour === 'litestream' && argv[0] === 'replicate') {
  const out = execFileSync('/bin/sh', [
    '-c',
    'eval "set -- $1"; printf "%s\\0" "$@"',
    'split',
    after('-exec'),
  ]);
  call.execWords = out.toString().split('\0').slice(0, -1);
}
appendFileSync(process.env.STUB_LOG ?? '/dev/null', JSON.stringify(call) + '\n');

switch (behaviour) {
  case 'fail':
    process.exit(1);
    break;
  case 'exec-rest': {
    const r = spawnSync(argv[1] ?? '', argv.slice(2), { stdio: 'inherit' });
    process.exit(r.status ?? 1);
    break;
  }
  case 'serve': {
    // A downloader: writes $STUB_BYTES to the output file named after -O (wget) or -o (curl).
    const flag = argv.includes('-O') ? '-O' : '-o';
    writeFileSync(after(flag), process.env.STUB_BYTES ?? '');
    process.exit(Number(process.env.STUB_DOWNLOAD_STATUS ?? 0));
    break;
  }
  case 'litestream':
    if (argv[0] === 'restore') {
      const mode = process.env.STUB_RESTORE ?? 'none';
      if (mode === 'fail') {
        process.stderr.write('restore failed\n');
        process.exit(1);
      }
      if (mode === 'create') writeFileSync(argv.at(-1) ?? '', '');
    }
    break;
  case 'answer': {
    // Canned answers for the workflow tests: STUB_ANSWERS_<NAME> is a JSON list of
    // { argv: string[] (a prefix), stdout?: string, status?: number }; the first match answers.
    /** @type {{ argv: string[], stdout?: string, status?: number }[]} */
    const answers = JSON.parse(process.env[`STUB_ANSWERS_${name.toUpperCase()}`] ?? '[]');
    const match = answers.find((a) => a.argv.every((word, i) => argv[i] === word));
    if (match?.stdout) process.stdout.write(match.stdout);
    process.exit(match?.status ?? 0);
    break;
  }
}
