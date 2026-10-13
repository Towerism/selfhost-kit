// The kit's own semantic-release config (ADR-0005). The shareable config for the apps is K3's
// `./release-config` export, not this file.
import createPreset, { DEFAULT_COMMIT_TYPES } from 'conventional-changelog-conventionalcommits';

// `fix(security)` gets its own section. The preset matches the first entry, and orders sections by
// this list, so Security comes first in the notes.
const presetConfig = {
  types: [{ type: 'fix', scope: 'security', section: 'Security' }, ...DEFAULT_COMMIT_TYPES],
};

const presetTransform = createPreset(presetConfig).writer.transform;
const ADVISORY = /^Advisory:\s*(GHSA(?:-[a-z0-9]{4}){3})\s*$/im;

/**
 * Shows a commit's `Advisory: GHSA-…` trailer next to its subject.
 * @param {{ body?: string | null; footer?: string | null; [key: string]: unknown }} commit
 * @param {unknown} context
 */
function transform(commit, context) {
  const entry = presetTransform(commit, context);
  // The parser only starts a footer at a note keyword (BREAKING CHANGE), so the trailer is often in the body.
  const advisory = entry && ADVISORY.exec(`${commit.body ?? ''}\n${commit.footer ?? ''}`)?.[1];
  if (!advisory) return entry;
  return { ...entry, subject: `${entry.subject} ([${advisory}](https://github.com/advisories/${advisory}))` };
}

const noRelease = ['docs', 'test', 'chore', 'ci', 'refactor', 'build', 'style'].map((type) => ({
  type,
  release: false,
}));

export default {
  branches: ['main'],
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'conventionalcommits',
        presetConfig,
        releaseRules: [
          // 0.x: a breaking change ships as a minor (ADR-0005). Remove this rule when cutting 1.0.0 (K5).
          { breaking: true, release: 'minor' },
          { type: 'feat', release: 'minor' },
          { type: 'fix', release: 'patch' },
          { type: 'perf', release: 'patch' },
          ...noRelease,
        ],
      },
    ],
    [
      '@semantic-release/release-notes-generator',
      { preset: 'conventionalcommits', presetConfig, writerOpts: { transform } },
    ],
    '@semantic-release/npm',
    // No comments or labels on issues and PRs, so the release job needs only `contents: write`.
    ['@semantic-release/github', { successComment: false, failComment: false, releasedLabels: false }],
  ],
};
