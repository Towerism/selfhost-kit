import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Vault, createVault } from '../../src/core/vault/index.js';
import {
  checkAadBinding,
  checkFreshSeal,
  checkTamperRefusal,
  describeVaultContract,
} from '../../src/testing/vault-contract.js';
import { VAULT_V1_VECTORS } from '../../src/testing/vault-vectors.js';
import { syntheticKey } from '../helpers/factories.js';

describeVaultContract('the kit vault', () => createVault({ key: syntheticKey(11), label: 'contract' }));

/** Wraps a real vault but seals and opens with one fixed AAD: the bug the AAD check exists to catch. */
function ignoresAad(vault: Vault): Vault {
  return { seal: (p) => vault.seal(p, 'fixed'), open: (b) => vault.open(b, 'fixed') };
}

describe('the vault contract fails a broken vault', () => {
  const real = createVault({ key: syntheticKey(12), label: 'contract' });

  it('when the vault ignores the AAD', () => {
    expect(() => {
      checkAadBinding(ignoresAad(real));
    }).toThrow();
  });

  it('when the vault reuses its IV', () => {
    const blob = real.seal(Buffer.from('x'), 'a');
    const reusing: Vault = { seal: () => Buffer.from(blob), open: (b, aad) => real.open(b, aad) };
    expect(() => {
      checkFreshSeal(reusing);
    }).toThrow();
  });

  it('when the vault accepts tampered data', () => {
    const lenient: Vault = { seal: (p, aad) => real.seal(p, aad), open: () => Buffer.alloc(0) };
    expect(() => {
      checkTamperRefusal(lenient);
    }).toThrow();
  });
});

describe('VAULT_V1_VECTORS', () => {
  it('equals the vectors in test/vectors/vault-v1.json', () => {
    const file = JSON.parse(readFileSync(new URL('../vectors/vault-v1.json', import.meta.url), 'utf8')) as {
      vectors: unknown[];
    };
    expect(VAULT_V1_VECTORS).toEqual(file.vectors);
    expect(Object.isFrozen(VAULT_V1_VECTORS)).toBe(true);
  });
});
