import { type SecretSpec, aes256Key, sessionPassword } from '../../src/core/secrets/index.js';

/** Attendance's three secret specs, exactly as its launcher declares them (architecture §5.2). */
export function attendanceSpecs(): SecretSpec[] {
  return [
    sessionPassword(),
    aes256Key({ env: 'NUXT_TOKEN_VAULT_KEY', file: 'token-vault.key', label: 'Token vault key' }),
    aes256Key({ env: 'NUXT_TDF_VAULT_KEY', file: 'tdf-vault.key', label: 'TDF vault key' }),
  ];
}

/** A synthetic 32-byte key, distinct per seed, as base64. */
export const syntheticKey = (seed: number) => Buffer.alloc(32, seed).toString('base64');

/** A synthetic session password, distinct per seed, at least 32 characters. */
export const syntheticPassword = (seed: number) =>
  `synthetic-session-password-${String(seed).padStart(8, '0')}`;
