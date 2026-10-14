import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { readCalls, stubBin, toolbox, type StubCall } from './shell.js';

const workflows = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const BASH = execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
// What the steps' shell needs besides its builtins; everything else on PATH is a stub.
const TOOLS = ['sed', 'grep', 'head', 'tail', 'cat', 'tr'];

export interface StepRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The `key=value` lines the step wrote to $GITHUB_OUTPUT. */
  outputs: Record<string, string>;
  calls: StubCall[];
}

export interface StepOptions {
  /** The step's `env:` values, as the runner would have expanded them. */
  env: Record<string, string>;
  /** Stub programs on PATH, each answering per STUB_ANSWERS_<NAME> (see stub-bin.cjs). */
  stubs?: Record<string, { argv: string[]; stdout?: string; status?: number }[]>;
  /** Extra files to create in the step's working directory, e.g. smoke scripts. */
  files?: Record<string, { content: string; mode?: number }>;
}

interface Step {
  name?: string;
  run?: string;
}

/** The `run:` script of the step named `stepName` in `.github/workflows/<file>`'s only job. */
export async function stepScript(file: string, stepName: string): Promise<string> {
  const workflow = parse(await readFile(join(workflows, file), 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const [job] = Object.values(workflow.jobs);
  const step = job?.steps.find((s) => s.name === stepName);
  if (!step?.run) throw new Error(`${file}: no run step named ${stepName}`);
  return step.run;
}

/**
 * Runs a workflow step's `run:` script the way the runner does with `shell: bash`
 * (`bash --noprofile --norc -eo pipefail`), in a temp working directory, with exactly `env` plus a PATH
 * that holds only basic tools and the given stubs, and a fresh $GITHUB_OUTPUT. Nothing touches the network.
 */
export async function runStep(file: string, stepName: string, options: StepOptions): Promise<StepRun> {
  const script = await stepScript(file, stepName);
  const dir = await mkdtemp(join(tmpdir(), 'selfhost-kit-step-'));
  try {
    const bin = await toolbox(join(dir, 'bin'), TOOLS);
    const answers: Record<string, string> = {};
    for (const [name, list] of Object.entries(options.stubs ?? {})) {
      await stubBin(bin, name, 'answer');
      answers[`STUB_ANSWERS_${name.toUpperCase()}`] = JSON.stringify(list);
    }
    const work = join(dir, 'work');
    await mkdir(work);
    for (const [name, { content, mode = 0o755 }] of Object.entries(options.files ?? {})) {
      await writeFile(join(work, name), content, { mode });
    }
    const output = join(dir, 'github-output');
    const log = join(dir, 'calls.jsonl');
    await writeFile(output, '');
    await writeFile(join(dir, 'step.sh'), script);

    const result = await new Promise<Omit<StepRun, 'outputs' | 'calls'>>((resolve) => {
      execFile(
        BASH,
        ['--noprofile', '--norc', '-eo', 'pipefail', join(dir, 'step.sh')],
        {
          cwd: work,
          env: { PATH: bin, GITHUB_OUTPUT: output, STUB_LOG: log, ...answers, ...options.env },
        },
        (err, stdout, stderr) => {
          const code = err ? (err as { code?: unknown }).code : 0;
          resolve({ code: typeof code === 'number' ? code : null, stdout, stderr });
        },
      );
    });
    const outputs = Object.fromEntries(
      (await readFile(output, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return { ...result, outputs, calls: await readCalls(log) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
