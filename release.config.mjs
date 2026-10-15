// The kit's own semantic-release config (ADR-0005). The shareable config for the apps is K3's
// `./release-config` export, not this file.
// The Security section and advisory links are shared with the apps' config (release-config/notes.js).
import { presetConfig, transform } from './release-config/notes.js';

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
          // A breaking change is a major (ADR-0005; it was a minor until 1.0, K5). Keep this rule, and keep it
          // first: commit-analyzer uses its own breaking → major only when none of these rules match, so
          // without it `feat!:` would release a minor and `refactor!:` nothing.
          { breaking: true, release: 'major' },
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
