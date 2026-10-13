// Builds test/vectors/vault-v1.json with WebCrypto only, never the kit's vault (ADR-0008: the
// implementation is never its own oracle). It first proves WebCrypto's AES-256-GCM against NIST CAVP
// vectors, then frames synthetic vectors in the v1 layout: version (1) | iv (12) | tag (16) | ciphertext.
//
//   node test/vectors/generate-vault-v1.ts           rewrite the JSON file
//   node test/vectors/generate-vault-v1.ts --check   exit 1 if the file differs from what this builds
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { subtle } = globalThis.crypto;
const OUT = fileURLToPath(new URL('./vault-v1.json', import.meta.url));

const SOURCE =
  'NIST CAVP gcmtestvectors.zip (gcmEncryptExtIV256.rsp, 2012-08-31), ' +
  'https://csrc.nist.gov/projects/cryptographic-algorithm-validation-program/cavp-testing-block-cipher-modes';

/** Count 0 of three [Keylen = 256][IVlen = 96][Taglen = 128] sections. */
const NIST = [
  {
    name: 'gcmEncryptExtIV256 PTlen=0 AADlen=128 Count=0',
    keyHex: '78dc4e0aaf52d935c3c01eea57428f00ca1fd475f5da86a49c8dd73d68c8e223',
    ivHex: 'd79cf22d504cc793c3fb6c8a',
    aadHex: 'b96baa8c1c75a671bfb2d08d06be5f36',
    plaintextHex: '',
    ciphertextHex: '',
    tagHex: '3e5d486aa2e30b22e040b85723a06e76',
  },
  {
    name: 'gcmEncryptExtIV256 PTlen=128 AADlen=0 Count=0',
    keyHex: '31bdadd96698c204aa9ce1448ea94ae1fb4a9a0b3c9d773b51bb1822666b8f22',
    ivHex: '0d18e06c7c725ac9e362e1ce',
    aadHex: '',
    plaintextHex: '2db5168e932556f8089a0622981d017d',
    ciphertextHex: 'fa4362189661d163fcd6a56d8bf0405a',
    tagHex: 'd636ac1bbedd5cc3ee727dc2ab4a9489',
  },
  {
    name: 'gcmEncryptExtIV256 PTlen=408 AADlen=384 Count=0',
    keyHex: '463b412911767d57a0b33969e674ffe7845d313b88c6fe312f3d724be68e1fca',
    ivHex: '611ce6f9a6880750de7da6cb',
    aadHex:
      '0a682fbc6192e1b47a5e0868787ffdafe5a50cead3575849990cdd2ea9b3597749403efb4a56684f0c6bde352d4aeec5',
    plaintextHex:
      'e7d1dcf668e2876861940e012fe52a98dacbd78ab63c08842cc9801ea581682ad54af0c34d0d7f6f59e8ee0bf4900e0fd85042',
    ciphertextHex:
      '8886e196010cb3849d9c1a182abe1eeab0a5f3ca423c3669a4a8703c0f146e8e956fb122e0d721b869d2b6fcd4216d7d4d3758',
    tagHex: '2469cecd70fd98fec9264f71df1aee9a',
  },
];

const bytes = (length: number, f: (i: number) => number) =>
  Uint8Array.from({ length }, (_, i) => f(i) & 0xff);
const hex = (u8: Uint8Array) => Buffer.from(u8).toString('hex');
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Synthetic inputs. IVs are fixed here only because a vector needs one; the vault never accepts an IV. */
const SYNTHETIC: (Input & { name: string })[] = [
  {
    name: 'empty plaintext',
    key: bytes(32, (i) => i),
    iv: bytes(12, (i) => 0xa0 + i),
    aad: 'pokemon_connection:1',
    plaintext: new Uint8Array(),
  },
  {
    name: 'one byte',
    key: bytes(32, (i) => 0xff - i),
    iv: bytes(12, (i) => i * 7),
    aad: 'a',
    plaintext: Uint8Array.of(0x00),
  },
  {
    name: 'one AES block',
    key: bytes(32, (i) => i * 3),
    iv: bytes(12, (i) => 0x10 + i),
    aad: 'tdf_file:default:abc',
    plaintext: bytes(16, (i) => i),
  },
  {
    name: 'one block and a byte',
    key: bytes(32, (i) => i * 5 + 1),
    iv: bytes(12, (i) => 0xf0 - i),
    aad: 'row:17',
    plaintext: bytes(17, (i) => 0x80 + i),
  },
  {
    name: 'every byte value',
    key: bytes(32, (i) => i * 11),
    iv: bytes(12, (i) => i * 13),
    aad: 'binary:all',
    plaintext: bytes(256, (i) => i),
  },
  {
    name: 'multi-byte UTF-8 text and AAD',
    key: bytes(32, (i) => 0x40 + i),
    iv: bytes(12, () => 0x55),
    aad: 'ligue:Montréal:🎴',
    plaintext: utf8('Pokémon ポケモン 🃏 refresh-token'),
  },
];

/** Attendance's golden blob (server/modules/pokemon/vault/vault.test.ts at 41aab72): all-7s key, AAD "default". */
const GOLDEN = {
  name: "attendance's golden blob",
  key: bytes(32, () => 7),
  aad: 'default',
  blobBase64: 'AbfWiVVN/vKVhQd5fhK97rvVWexlQ/aJWBkQm0/HHmiMFV/pGXag4c/7v87dxW5W8JFbEplJMVk=',
  plaintext: utf8('ory_rt_golden-refresh-token'),
};

interface Input {
  key: Uint8Array;
  iv: Uint8Array;
  aad: string;
  plaintext: Uint8Array;
}

async function gcm(
  op: 'encrypt' | 'decrypt',
  keyBytes: Uint8Array,
  iv: Uint8Array,
  aad: Uint8Array,
  data: Uint8Array,
) {
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, [op]);
  return new Uint8Array(
    await subtle[op]({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, data),
  );
}

async function checkNist() {
  for (const c of NIST) {
    const out = await gcm(
      'encrypt',
      Buffer.from(c.keyHex, 'hex'),
      Buffer.from(c.ivHex, 'hex'),
      Buffer.from(c.aadHex, 'hex'),
      Buffer.from(c.plaintextHex, 'hex'),
    );
    if (hex(out) !== c.ciphertextHex + c.tagHex)
      throw new Error(`WebCrypto disagrees with NIST on ${c.name}`);
  }
}

async function frame({ key, iv, aad, plaintext }: Input) {
  const sealed = await gcm('encrypt', key, iv, utf8(aad), plaintext);
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  return Buffer.concat([Uint8Array.of(1), iv, tag, ciphertext]);
}

async function openGolden() {
  const blob = Buffer.from(GOLDEN.blobBase64, 'base64');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const ciphertext = blob.subarray(29);
  const plaintext = await gcm('decrypt', GOLDEN.key, iv, utf8(GOLDEN.aad), Buffer.concat([ciphertext, tag]));
  if (hex(plaintext) !== hex(GOLDEN.plaintext)) throw new Error('WebCrypto does not open the golden blob');
}

export async function buildVectors() {
  await checkNist();
  await openGolden();
  const vectors: {
    name: string;
    keyBase64: string;
    aad: string;
    plaintextHex: string;
    blobBase64: string;
  }[] = [];
  for (const v of SYNTHETIC) {
    const blob = await frame(v);
    vectors.push({
      name: v.name,
      keyBase64: Buffer.from(v.key).toString('base64'),
      aad: v.aad,
      plaintextHex: hex(v.plaintext),
      blobBase64: blob.toString('base64'),
    });
  }
  vectors.push({
    name: GOLDEN.name,
    keyBase64: Buffer.from(GOLDEN.key).toString('base64'),
    aad: GOLDEN.aad,
    plaintextHex: hex(GOLDEN.plaintext),
    blobBase64: GOLDEN.blobBase64,
  });
  return { source: SOURCE, nist: NIST, vectors };
}

export const serialize = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = serialize(await buildVectors());
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== text) {
      console.error('test/vectors/vault-v1.json is out of date: run node test/vectors/generate-vault-v1.ts');
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, text);
  }
}
