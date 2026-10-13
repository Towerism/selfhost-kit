import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM at rest. Blob v1, frozen (ADR-0005 rule 2), byte for byte attendance's format:
 * `version (1) | iv (12) | auth tag (16) | ciphertext`. The caller's AAD binds a blob to the row it was
 * written for, so a blob copied to another row doesn't open. Bind it as `<table>:<row id>`.
 */
export interface Vault {
  /** Seals with a fresh random IV. Nothing lets a caller choose the IV. @throws VaultError on an empty AAD. */
  seal(plaintext: Uint8Array, aad: string): Buffer;
  /** @throws VaultError when the blob is malformed, tampered with, or sealed with another key or AAD. */
  open(blob: Uint8Array, aad: string): Buffer;
}

/** Every vault failure. Messages are for the operator and never contain a key, AAD or plaintext. */
export class VaultError extends Error {
  override name = 'VaultError';
}

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** True when `value` is what the secret files hold for a vault key: 32 bytes, standard base64. */
export function isAes256Key(value: string): boolean {
  return BASE64.test(value) && Buffer.from(value, 'base64').length === 32;
}

/**
 * @param opts.key 32 bytes, standard base64 (what an `aes256Key()` secret file holds).
 * @param opts.label names the vault in error messages, e.g. `token` or `TDF`.
 * @throws VaultError when the key isn't 32 bytes of base64.
 */
export function createVault(opts: { key: string; label: string }): Vault {
  const { label } = opts;
  if (!isAes256Key(opts.key))
    throw new VaultError(`The ${label} vault key must be 32 bytes, base64-encoded.`);
  const key = Buffer.from(opts.key, 'base64');
  const requireAad = (aad: string) => {
    if (aad === '')
      throw new VaultError(`The ${label} vault needs a non-empty AAD that binds the data to its row.`);
  };

  return {
    seal(plaintext, aad) {
      requireAad(aad);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
    },

    open(blob, aad) {
      requireAad(aad);
      if (blob.length < HEADER_BYTES || blob[0] !== VERSION) {
        throw new VaultError(`The stored ${label} data is not in a format this version understands.`);
      }
      const iv = blob.subarray(1, 1 + IV_BYTES);
      const tag = blob.subarray(1 + IV_BYTES, HEADER_BYTES);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(blob.subarray(HEADER_BYTES)), decipher.final()]);
      } catch (err) {
        throw new VaultError(
          `The stored ${label} data could not be decrypted (wrong key or tampered data).`,
          {
            cause: err,
          },
        );
      }
    },
  };
}

/** UTF-8 strings over a {@link Vault}, for tokens and secrets. */
export interface StringVault {
  encrypt(plaintext: string, aad: string): Buffer;
  /** @throws VaultError, unwrapped. */
  decrypt(blob: Uint8Array, aad: string): string;
}

export function stringVault(vault: Vault): StringVault {
  return {
    encrypt: (plaintext, aad) => vault.seal(Buffer.from(plaintext, 'utf8'), aad),
    decrypt: (blob, aad) => vault.open(blob, aad).toString('utf8'),
  };
}
