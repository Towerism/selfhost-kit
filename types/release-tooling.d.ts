// The release tooling ships no types. These cover only what release.config.mjs and its tests use.

declare module 'conventional-changelog-conventionalcommits' {
  export interface CommitType {
    type: string;
    scope?: string;
    section?: string;
    hidden?: boolean;
  }
  export interface WriterCommit {
    subject?: string | null;
    [key: string]: unknown;
  }
  export const DEFAULT_COMMIT_TYPES: readonly CommitType[];
  export default function createPreset(config?: { types?: readonly CommitType[] }): {
    writer: {
      transform: (commit: Record<string, unknown>, context: unknown) => WriterCommit | undefined;
    };
  };
}

declare module '@semantic-release/commit-analyzer' {
  export function analyzeCommits(
    pluginConfig: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<string | null>;
}

declare module '@semantic-release/release-notes-generator' {
  export function generateNotes(
    pluginConfig: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<string>;
}
