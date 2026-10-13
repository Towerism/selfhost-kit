import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('./ts-resolve.mjs', import.meta.url));

/** An absolute file URL for a source module, for `import` statements inside a child's script. */
export const sourceUrl = (path: string) => new URL(`../../${path}`, import.meta.url).href;

export interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs an ES module snippet (or a file, with `file`) in a fresh Node process that can import the
 * TypeScript source, with exactly `env` as its environment. Resolves on any exit code.
 */
export function runModule(opts: {
  source?: string;
  file?: string;
  env: Record<string, string>;
}): Promise<ChildResult> {
  const args = ['--import', HOOK];
  if (opts.file) args.push(opts.file);
  else args.push('--input-type=module', '--eval', opts.source ?? '');
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env: opts.env }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: unknown }).code as number | null) : 0;
      resolve({ code: typeof code === 'number' ? code : null, stdout, stderr });
    });
  });
}
