// Release-notes pieces shared by the apps' config (./index.js) and the kit's own (release.config.mjs).
// Not exported from the package: only `@towerism/selfhost-kit/release-config` is public.
import createPreset, { DEFAULT_COMMIT_TYPES } from 'conventional-changelog-conventionalcommits';

/**
 * `fix(security)` gets its own section (ADR-0005). The preset matches the first entry, and orders
 * sections by this list, so Security comes first in the notes.
 */
export const presetConfig = {
  types: [{ type: 'fix', scope: 'security', section: 'Security' }, ...DEFAULT_COMMIT_TYPES],
};

const presetTransform = createPreset(presetConfig).writer.transform;
const ADVISORY = /^Advisory:\s*(GHSA(?:-[a-z0-9]{4}){3})\s*$/im;

/**
 * Shows a commit's `Advisory: GHSA-…` trailer next to its subject.
 * @param {{ body?: string | null; footer?: string | null; [key: string]: unknown }} commit
 * @param {unknown} context
 */
export function transform(commit, context) {
  const entry = presetTransform(commit, context);
  // The parser only starts a footer at a note keyword (BREAKING CHANGE), so the trailer is often in the body.
  const advisory = entry && ADVISORY.exec(`${commit.body ?? ''}\n${commit.footer ?? ''}`)?.[1];
  if (!advisory) return entry;
  return { ...entry, subject: `${entry.subject} ([${advisory}](https://github.com/advisories/${advisory}))` };
}
