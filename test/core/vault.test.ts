import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VaultError, createVault, stringVault } from '../../src/core/vault/index.js';
import { buildVectors, serialize } from '../vectors/generate-vault-v1.js';

interface VectorFile {
  vectors: { name: string; keyBase64: string; aad: string; plaintextHex: string; blobBase64: string }[];
}

const VECTOR_FILE = new URL('../vectors/vault-v1.json', import.meta.url);
const vectors = (JSON.parse(readFileSync(VECTOR_FILE, 'utf8')) as VectorFile).vectors;

const newKey = () => randomBytes(32).toString('base64');
const KEY = newKey();
const AAD = 'pokemon_connection:42';
const PLAINTEXT = Buffer.from('<player userid="1"><birthdate>01/02/2012</birthdate></player>');

/** Decrypts a v1 blob with WebCrypto, the reference that shares no code with the vault. */
async function referenceOpen(keyBase64: string, blob: Buffer, aad: string): Promise<Buffer> {
  const key = await crypto.subtle.importKey('raw', Buffer.from(keyBase64, 'base64'), 'AES-GCM', false, [
    'decrypt',
  ]);
  const iv = blob.subarray(1, 13);
  const sealed = Buffer.concat([blob.subarray(29), blob.subarray(13, 29)]);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad), tagLength: 128 },
    key,
    sealed,
  );
  return Buffer.from(plain);
}

/** The message must name nothing the caller handed in. */
function expectNoEcho(fn: () => unknown, ...secrets: string[]) {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(VaultError);
  const message = (thrown as Error).message;
  for (const secret of secrets.filter(Boolean)) expect(message).not.toContain(secret);
  return message;
}

describe('vault known-answer vectors', () => {
  it('match what the WebCrypto generator builds, NIST self-check included', async () => {
    expect(readFileSync(VECTOR_FILE, 'utf8')).toBe(serialize(await buildVectors()));
  });

  it.each(vectors.map((v) => [v.name, v] as const))('opens %s', (_name, v) => {
    const vault = createVault({ key: v.keyBase64, label: 'test' });
    expect(vault.open(Buffer.from(v.blobBase64, 'base64'), v.aad).toString('hex')).toBe(v.plaintextHex);
  });

  it("includes attendance's golden blob, which still opens to its refresh token", () => {
    const golden = vectors.find((v) => v.name === "attendance's golden blob")!;
    const vault = stringVault(createVault({ key: Buffer.alloc(32, 7).toString('base64'), label: 'token' }));
    expect(vault.decrypt(Buffer.from(golden.blobBase64, 'base64'), 'default')).toBe(
      'ory_rt_golden-refresh-token',
    );
  });
});

describe('seal', () => {
  const samples: [string, Buffer][] = [
    ['empty', Buffer.alloc(0)],
    ['1 byte', Buffer.from([0])],
    ['15 bytes', randomBytes(15)],
    ['16 bytes', randomBytes(16)],
    ['17 bytes', randomBytes(17)],
    ['64 KiB', randomBytes(64 * 1024)],
    ['every byte value', Buffer.from(Array.from({ length: 256 }, (_, i) => i))],
    ['multi-byte UTF-8', Buffer.from('Pokémon ポケモン 🃏')],
  ];

  it.each(samples)(
    'writes a fresh v1 blob for %s that the reference and the vault both open',
    async (_l, plain) => {
      const vault = createVault({ key: KEY, label: 'test' });
      const a = vault.seal(plain, AAD);
      const b = vault.seal(plain, AAD);

      expect(a[0]).toBe(1);
      expect(a.length).toBe(29 + plain.length);
      expect(a.equals(b)).toBe(false);
      expect((await referenceOpen(KEY, a, AAD)).equals(plain)).toBe(true);
      expect(vault.open(a, AAD).equals(plain)).toBe(true);
    },
  );

  it('never holds the plaintext', () => {
    const blob = createVault({ key: KEY, label: 'test' }).seal(PLAINTEXT, AAD);
    expect(blob.toString('latin1')).not.toContain('birthdate');
  });

  it('accepts a Uint8Array as well as a Buffer', () => {
    const vault = createVault({ key: KEY, label: 'test' });
    const blob = vault.seal(new Uint8Array([1, 2, 3]), AAD);
    expect([...vault.open(new Uint8Array(blob), AAD)]).toEqual([1, 2, 3]);
  });

  it('refuses an empty AAD, naming the vault and nothing else', () => {
    const vault = createVault({ key: KEY, label: 'TDF' });
    const message = expectNoEcho(() => vault.seal(PLAINTEXT, ''), KEY, 'birthdate');
    expect(message).toMatch(/TDF/);
  });

  it('offers no way to choose the IV', () => {
    const vault = createVault({ key: KEY, label: 'test' });
    expect(vault.seal.length).toBe(2);
    expect(Object.keys(vault).sort()).toEqual(['open', 'seal']);
  });
});

describe('open refuses anything but an untouched blob for the same key and AAD', () => {
  const vault = createVault({ key: KEY, label: 'TDF' });
  const sample = vault.seal(randomBytes(64), AAD);
  const notUnderstood = 'The stored TDF data is not in a format this version understands.';
  const notDecrypted = 'The stored TDF data could not be decrypted (wrong key or tampered data).';

  it('refuses every single-bit flip in the IV, the tag and the ciphertext', () => {
    for (let bit = 8; bit < sample.length * 8; bit++) {
      const blob = Buffer.from(sample);
      blob[bit >> 3]! ^= 1 << (bit & 7);
      expect(() => vault.open(blob, AAD), `bit ${String(bit)}`).toThrow(notDecrypted);
    }
  });

  it('refuses every bit flip in the version byte as an unknown format', () => {
    for (let bit = 0; bit < 8; bit++) {
      const blob = Buffer.from(sample);
      blob[0]! ^= 1 << bit;
      expect(() => vault.open(blob, AAD)).toThrow(notUnderstood);
    }
  });

  it('refuses a blob truncated to any length shorter than the header', () => {
    for (let length = 0; length <= 28; length++) {
      expect(() => vault.open(sample.subarray(0, length), AAD), `length ${String(length)}`).toThrow(
        notUnderstood,
      );
    }
  });

  it('opens a header-only blob as an empty plaintext', () => {
    const empty = vault.seal(Buffer.alloc(0), AAD);
    expect(empty.length).toBe(29);
    expect(vault.open(empty, AAD).length).toBe(0);
  });

  it.each([0, 2, 255])('refuses version %i', (version) => {
    const blob = Buffer.from(sample);
    blob[0] = version;
    expect(() => vault.open(blob, AAD)).toThrow(notUnderstood);
  });

  it('refuses another key, keeping the cause', () => {
    const other = newKey();
    let thrown: unknown;
    try {
      createVault({ key: other, label: 'TDF' }).open(sample, AAD);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VaultError);
    expect((thrown as Error).message).toBe(notDecrypted);
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(other);
  });

  it.each(['pokemon_connection:43', 'Pokemon_connection:42', `${AAD} `, `${AAD}\0`])(
    'refuses another AAD (%j), so a blob copied to another row does not open',
    (aad) => {
      expectNoEcho(() => vault.open(sample, aad), KEY, aad);
    },
  );

  it('refuses an empty AAD before trying to decrypt', () => {
    expect(expectNoEcho(() => vault.open(sample, ''), KEY)).not.toBe(notDecrypted);
  });

  it('has a VaultError that names itself', () => {
    expect(new VaultError('x').name).toBe('VaultError');
  });
});

describe('createVault', () => {
  it.each([
    ['empty', ''],
    ['0 bytes of padding only', '===='],
    ['16 bytes', randomBytes(16).toString('base64')],
    ['31 bytes', randomBytes(31).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['not base64', '!'.repeat(44)],
    ['base64url characters', randomBytes(32).toString('base64url').replace(/[^-_]/, '-')],
    ['embedded whitespace', `${KEY.slice(0, 20)} ${KEY.slice(20)}`],
  ])('refuses a key that is %s, without echoing it', (_label, key) => {
    const message = expectNoEcho(() => createVault({ key, label: 'TDF' }), key);
    expect(message).toBe('The TDF vault key must be 32 bytes, base64-encoded.');
  });

  it('accepts 32 bytes of base64, padded or not', () => {
    expect(() => createVault({ key: KEY, label: 'x' })).not.toThrow();
    expect(() => createVault({ key: KEY.replace(/=+$/, ''), label: 'x' })).not.toThrow();
  });
});

describe('stringVault', () => {
  const vault = stringVault(createVault({ key: KEY, label: 'token' }));

  it.each(['ory_rt_example-refresh-token', 'emoji 🃏🎴', '漢字とかな', ''])('round-trips %j', (text) => {
    expect(vault.decrypt(vault.encrypt(text, AAD), AAD)).toBe(text);
  });

  it('keeps VaultError for a tampered blob, with no wrapping class', () => {
    const blob = vault.encrypt('secret', AAD);
    blob[blob.length - 1]! ^= 1;
    expect(() => vault.decrypt(blob, AAD)).toThrow(VaultError);
    try {
      vault.decrypt(blob, AAD);
    } catch (err) {
      expect((err as Error).constructor).toBe(VaultError);
    }
  });
});
