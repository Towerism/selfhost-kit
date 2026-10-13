import { describe, expect, it } from 'vitest';
import { type Vault, VaultError } from '../core/vault/index.js';

const PLAINTEXTS = [
  Buffer.alloc(0),
  Buffer.from([0]),
  Buffer.from('Pokémon 🃏 refresh-token'),
  Buffer.alloc(4096, 7),
];
const SAMPLE = Buffer.from('contract sample plaintext');

/** Seal then open returns the same bytes, for empty, tiny, UTF-8 and larger plaintexts. */
export function checkRoundTrip(vault: Vault): void {
  for (const plaintext of PLAINTEXTS) {
    expect(vault.open(vault.seal(plaintext, 'contract:1'), 'contract:1').equals(plaintext)).toBe(true);
  }
}

/** A blob sealed for one row doesn't open for another (the AAD binds it). */
export function checkAadBinding(vault: Vault): void {
  const blob = vault.seal(SAMPLE, 'contract:1');
  expect(() => vault.open(blob, 'contract:2')).toThrow(VaultError);
}

/** A single flipped bit in the IV, the tag or the ciphertext is refused. */
export function checkTamperRefusal(vault: Vault): void {
  const blob = vault.seal(SAMPLE, 'contract:1');
  for (const [part, index] of [
    ['IV', 1],
    ['tag', 13],
    ['ciphertext', blob.length - 1],
  ] as const) {
    const tampered = Buffer.from(blob);
    tampered[index] = (tampered[index] ?? 0) ^ 0x01;
    expect(() => vault.open(tampered, 'contract:1'), part).toThrow(VaultError);
  }
}

/** Two seals of the same input differ, so a fresh IV is used every time. */
export function checkFreshSeal(vault: Vault): void {
  expect(vault.seal(SAMPLE, 'contract:1').equals(vault.seal(SAMPLE, 'contract:1'))).toBe(false);
}

/**
 * Registers Vitest tests that check the vault exactly as the app builds it: round trip, AAD binding,
 * tamper refusal and a fresh IV per seal. `makeVault` is called once per test.
 */
export function describeVaultContract(name: string, makeVault: () => Vault): void {
  describe(`vault contract: ${name}`, () => {
    it('round-trips every plaintext', () => {
      checkRoundTrip(makeVault());
    });
    it('binds a blob to its AAD', () => {
      checkAadBinding(makeVault());
    });
    it('refuses a flipped bit in the IV, tag and ciphertext', () => {
      checkTamperRefusal(makeVault());
    });
    it('seals with a fresh IV every time', () => {
      checkFreshSeal(makeVault());
    });
  });
}
