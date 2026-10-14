import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// The Renovate config apps copy from docs/ops-assets.md. A grouped kit + workflow-SHA update must be a
// `fix` commit, or merging it releases nothing in the app and a kit fix never ships (ADR-0005).
describe('the Renovate config in docs/ops-assets.md', () => {
  async function renovateConfig() {
    const doc = await readFile(new URL('../docs/ops-assets.md', import.meta.url), 'utf8');
    const section = doc.slice(doc.indexOf('## Renovate (in each app)'));
    const block = /```json\n([\s\S]*?)```/.exec(section);
    return JSON.parse(block![1]!) as {
      semanticCommits?: string;
      packageRules: { groupName?: string; matchPackageNames?: string[]; semanticCommitType?: string }[];
    };
  }

  it('turns semantic commits on instead of leaving them to auto-detection', async () => {
    expect((await renovateConfig()).semanticCommits).toBe('enabled');
  });

  it('makes the selfhost-kit group a fix, for both the package and the workflow SHA', async () => {
    const group = (await renovateConfig()).packageRules.find((rule) => rule.groupName === 'selfhost-kit');
    expect(group?.semanticCommitType).toBe('fix');
    expect(group?.matchPackageNames).toEqual(
      expect.arrayContaining(['@towerism/selfhost-kit', 'Towerism/selfhost-kit']),
    );
  });
});
