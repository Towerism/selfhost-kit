import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `sh <script> …args` with exactly `env` (nothing inherited), resolving on any exit code. */
export function runShell(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    execFile('/bin/sh', [script, ...args], { env }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: unknown }).code as number | null) : 0;
      resolve({ code: typeof code === 'number' ? code : null, stdout, stderr });
    });
  });
}

/**
 * Makes `dir` a bin directory holding only `tools`, each a symlink to the host's copy, so a script run
 * with `PATH=dir` sees exactly those programs and nothing else (no stray curl, gosu or litestream).
 */
export async function toolbox(dir: string, tools: readonly string[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  for (const tool of tools) {
    const path = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    await symlink(path, join(dir, tool));
  }
  return dir;
}

/** One call a stub binary recorded. */
export interface StubCall {
  tool: string;
  argv: string[];
  /** For `litestream replicate -exec <s>`: `<s>` split back into words by `sh`. */
  execWords?: string[];
  env: Record<string, string | undefined>;
}

/**
 * Writes a stub executable `name` into `dir`. It appends a JSON line describing its call to `$STUB_LOG`,
 * then does what `behaviour` says. Stubs record what they were asked; the outcome comes from the script.
 */
export async function stubBin(
  dir: string,
  name: string,
  behaviour: 'record' | 'exec-rest' | 'litestream' | 'serve' | 'fail' = 'record',
): Promise<void> {
  const source = `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const argv = process.argv.slice(2);
const call = { tool: ${JSON.stringify(name)}, argv, env: {
  LITESTREAM_REPLICA_URL: process.env.LITESTREAM_REPLICA_URL,
  NUXT_DATABASE_PATH: process.env.NUXT_DATABASE_PATH,
} };
const behaviour = ${JSON.stringify(behaviour)};
if (behaviour === 'litestream' && argv[0] === 'replicate') {
  const exec = argv[argv.indexOf('-exec') + 1];
  const out = execFileSync('/bin/sh', ['-c', 'eval "set -- $1"; printf "%s\\\\0" "$@"', 'split', exec]);
  call.execWords = out.toString().split('\\0').slice(0, -1);
}
appendFileSync(process.env.STUB_LOG, JSON.stringify(call) + '\\n');
if (behaviour === 'fail') process.exit(1);
if (behaviour === 'exec-rest') {
  const r = spawnSync(argv[1], argv.slice(2), { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
if (behaviour === 'serve') {
  // A downloader: writes $STUB_BYTES to the output file named after -O (wget) or -o (curl).
  const flag = argv.includes('-O') ? '-O' : '-o';
  writeFileSync(argv[argv.indexOf(flag) + 1], process.env.STUB_BYTES ?? '');
  process.exit(Number(process.env.STUB_DOWNLOAD_STATUS ?? 0));
}
if (behaviour === 'litestream' && argv[0] === 'restore') {
  const mode = process.env.STUB_RESTORE ?? 'none';
  if (mode === 'fail') { process.stderr.write('restore failed\\n'); process.exit(1); }
  if (mode === 'create') writeFileSync(argv.at(-1), '');
}
`;
  const path = join(dir, name);
  await writeFile(path, source);
  await chmod(path, 0o755);
}

export async function readCalls(log: string): Promise<StubCall[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StubCall);
}
