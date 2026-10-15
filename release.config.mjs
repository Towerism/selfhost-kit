// The kit's own semantic-release config (ADR-0005). The shareable config for the apps is K3's
// `./release-config` export, not this file.
// The Security section and advisory links are shared with the apps' config (release-config/notes.js).
import { presetConfig, transform } from './release-config/notes.js';

// The kit's commits end with a Co-Authored-By trailer, which the parser appends to a BREAKING CHANGE note.
// Kept out of the notes here only: the apps' shared config is unchanged.
const TRAILERS = /(?:\n\s*Co-authored-by:[^\n]*)+\s*$/i;
/** @type {typeof transform} */
const kitTransform = (commit, context) => {
  const entry = transform(commit, context);
  if (!entry) return entry;
  const notes = /** @type {{ text: string }[]} */ (entry.notes ?? []);
  return {
    ...entry,
    notes: notes.map((note) => ({ ...note, text: note.text.replace(TRAILERS, '').trimEnd() })),
  };
};

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
      { preset: 'conventionalcommits', presetConfig, writerOpts: { transform: kitTransform } },
    ],
    '@semantic-release/npm',
    // No comments or labels on issues and PRs, so the release job needs only `contents: write`.
    ['@semantic-release/github', { successComment: false, failComment: false, releasedLabels: false }],
  ],
};
