import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const STUB_SCRIPT = fileURLToPath(new URL('stub-bin.cjs', import.meta.url));

/** Single-quotes `word` for sh. */
const shQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

export type StubBehaviour = 'record' | 'exec-rest' | 'litestream' | 'serve' | 'fail' | 'answer';

/**
 * Writes a stub executable `name` into `dir`: a two-line sh wrapper over the static stub-bin.cjs, which
 * appends a JSON line describing its call to `$STUB_LOG`, then does what `behaviour` says. Stubs record
 * what they were asked; the outcome comes from the script. Node is named by absolute path because the
 * scripts under test run with a `PATH` that holds no `node`.
 */
export async function stubBin(dir: string, name: string, behaviour: StubBehaviour = 'record'): Promise<void> {
  const words = [process.execPath, STUB_SCRIPT, name, behaviour].map(shQuote).join(' ');
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\nexec ${words} "$@"\n`);
  await chmod(path, 0o755);
}

export async function readCalls(log: string): Promise<StubCall[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StubCall);
}
