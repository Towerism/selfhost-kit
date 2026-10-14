// @towerism/selfhost-kit/release-config: the apps' shared semantic-release config (ADR-0004, ADR-0005).
// An app's .releaserc.json is `{ "extends": "@towerism/selfhost-kit/release-config" }`. It needs
// semantic-release, @semantic-release/exec and conventional-changelog-conventionalcommits installed.
//
// The app-release workflow runs `semantic-release --dry-run` first: the exec step writes the next version
// to $RUNNER_TEMP/release-version, the workflow tags the tested image with it, and only then does the
// real run push the git tag and the GitHub Release. Nothing is published to npm.
import { presetConfig, transform } from './notes.js';

export default {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    // The preset's own rules: feat → minor, fix/perf → patch, breaking → major.
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits', presetConfig }],
    [
      '@semantic-release/release-notes-generator',
      { preset: 'conventionalcommits', presetConfig, writerOpts: { transform } },
    ],
    [
      '@semantic-release/exec',
      { verifyReleaseCmd: 'echo ${nextRelease.version} > "$RUNNER_TEMP/release-version"' },
    ],
    // No comments or labels on issues and PRs, so the release job needs only `contents: write`.
    ['@semantic-release/github', { successComment: false, failComment: false, releasedLabels: false }],
  ],
};
