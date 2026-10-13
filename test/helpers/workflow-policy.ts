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

/**
 * Supply-chain rules for every workflow (ADR-0004): third-party actions are pinned to a full commit SHA
 * with a `# vX.Y.Z` comment, and each workflow sets its default token permissions explicitly.
 */
export async function findWorkflowViolations(workflowDir: string): Promise<WorkflowViolation[]> {
  const files = (await readdir(workflowDir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  const violations: WorkflowViolation[] = [];

  for (const file of files) {
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
