import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface WorkflowViolation {
  file: string;
  line: number;
  rule: 'unpinned-action' | 'missing-permissions';
}

const USES = /^\s*(?:-\s*)?uses:\s*(['"]?)([^\s'"#]+)\1\s*(#.*)?$/;
// A full commit SHA, followed by the version it stands for, so a reviewer can read it.
const PINNED = /@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^#\s*v\d/;

export interface ToolPin {
  file: string;
  datasource: string;
  depName: string;
  currentValue: string;
  currentDigest: string;
}

export interface ToolPinViolation {
  file: string;
  line: number;
  rule: 'untracked-tool-pin';
}

const TOOL_VERSION = /^\s*[A-Z0-9_]+_VERSION:/;

async function workflowFiles(workflowDir: string): Promise<string[]> {
  return (await readdir(workflowDir)).filter((f) => /\.ya?ml$/.test(f)).sort();
}

/**
 * Applies Renovate's regex-manager `matchStrings` to every workflow, the way Renovate does, and reports each
 * `<TOOL>_VERSION` entry they don't capture: Renovate would never update it, so the pin would go stale.
 */
export async function findToolPins(
  workflowDir: string,
  matchStrings: string[],
): Promise<{ pins: ToolPin[]; violations: ToolPinViolation[] }> {
  const pins: ToolPin[] = [];
  const violations: ToolPinViolation[] = [];

  for (const file of await workflowFiles(workflowDir)) {
    const text = await readFile(join(workflowDir, file), 'utf8');
    const captured: [start: number, end: number][] = [];

    for (const source of matchStrings) {
      for (const match of text.matchAll(new RegExp(source, 'g'))) {
        const { datasource = '', depName = '', currentValue = '', currentDigest = '' } = match.groups ?? {};
        pins.push({ file, datasource, depName, currentValue, currentDigest });
        captured.push([match.index, match.index + match[0].length]);
      }
    }

    let offset = 0;
    text.split('\n').forEach((source, index) => {
      const covered = captured.some(([start, end]) => offset >= start && offset < end);
      if (TOOL_VERSION.test(source) && !covered) {
        violations.push({ file, line: index + 1, rule: 'untracked-tool-pin' });
      }
      offset += source.length + 1;
    });
  }

  return { pins, violations };
}

/**
 * Supply-chain rules for every workflow (ADR-0004): third-party actions are pinned to a full commit SHA
 * with a `# vX.Y.Z` comment, and each workflow sets its default token permissions explicitly.
 */
export async function findWorkflowViolations(workflowDir: string): Promise<WorkflowViolation[]> {
  const violations: WorkflowViolation[] = [];

  for (const file of await workflowFiles(workflowDir)) {
    const text = await readFile(join(workflowDir, file), 'utf8');

    const workflow = parse(text) as Record<string, unknown> | null;
    if (!workflow || !('permissions' in workflow)) {
      violations.push({ file, line: 1, rule: 'missing-permissions' });
    }

    text.split('\n').forEach((source, index) => {
      const match = USES.exec(source);
      if (!match) return;
      const [, , action = '', comment = ''] = match;
      if (action.startsWith('./')) return;
      if (!PINNED.test(action) || !VERSION_COMMENT.test(comment)) {
        violations.push({ file, line: index + 1, rule: 'unpinned-action' });
      }
    });
  }

  return violations;
}
