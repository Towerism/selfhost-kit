import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The secret scan reads this file from the repo root. Any widening of the allowlist must show up here.
const EXPECTED = `# gitleaks (CI secret-scan): the default rules, plus one narrow exception.
[extend]
useDefault = true

# The vault's known-answer vectors hold keys on purpose: NIST's published AES-256-GCM vectors and
# synthetic keys such as attendance's all-7s golden key. Only generic-api-key is waived, only here.
[[allowlists]]
description = "Vault known-answer test keys (public NIST vectors and synthetic keys)"
targetRules = ["generic-api-key"]
paths = [
  '''^test/vectors/vault-v1\\.json$''',
  '''^test/vectors/generate-vault-v1\\.ts$''',
  '''^src/testing/vault-vectors\\.ts$''',
]
`;

describe('.gitleaks.toml', () => {
  it('extends the default rules and waives only generic-api-key, only for the three vector files', () => {
    expect(readFileSync(new URL('../.gitleaks.toml', import.meta.url), 'utf8')).toBe(EXPECTED);
  });
});
