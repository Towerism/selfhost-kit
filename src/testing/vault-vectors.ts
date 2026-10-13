/** One vault v1 known answer: `open(blob, aad)` with this key must return this plaintext. */
export interface VaultVector {
  name: string;
  /** 32 bytes, standard base64. */
  keyBase64: string;
  aad: string;
  plaintextHex: string;
  blobBase64: string;
}

/**
 * The vault's v1 known-answer vectors, attendance's golden blob included. Built by an independent WebCrypto
 * generator that checks itself against NIST CAVP vectors (the kit's test/vectors/vault-v1.json, which a
 * kit test keeps equal to this list). A later kit version, or an app, can run them to prove v1 still opens.
 */
export const VAULT_V1_VECTORS: readonly VaultVector[] = Object.freeze([
  {
    name: 'empty plaintext',
    keyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
    aad: 'pokemon_connection:1',
    plaintextHex: '',
    blobBase64: 'AaChoqOkpaanqKmqqxJnsCnc8piyBB5GIw9l56Q=',
  },
  {
    name: 'one byte',
    keyBase64: '//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=',
    aad: 'a',
    plaintextHex: '00',
    blobBase64: 'AQAHDhUcIyoxOD9GTRh+oOTtXh4qqebovgBh7JTP',
  },
  {
    name: 'one AES block',
    keyBase64: 'AAMGCQwPEhUYGx4hJCcqLTAzNjk8P0JFSEtOUVRXWl0=',
    aad: 'tdf_file:default:abc',
    plaintextHex: '000102030405060708090a0b0c0d0e0f',
    blobBase64: 'ARAREhMUFRYXGBkaG4X5FYc8/aMHgALaoLpIyIkvxGZ0VJbWr3FWd4MvVySh',
  },
  {
    name: 'one block and a byte',
    keyBase64: 'AQYLEBUaHyQpLjM4PUJHTFFWW2Blam90eX6DiI2Sl5w=',
    aad: 'row:17',
    plaintextHex: '808182838485868788898a8b8c8d8e8f90',
    blobBase64: 'AfDv7u3s6+rp6Ofm5bRb0X0qMluiXMX+XRYypCrwBmWsJLr+VIUFpHF6kFcwFA==',
  },
  {
    name: 'every byte value',
    keyBase64: 'AAsWISw3Qk1YY255hI+apbC7xtHc5/L9CBMeKTQ/SlU=',
    aad: 'binary:all',
    plaintextHex:
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
    blobBase64:
      'AQANGic0QU5baHWCjwL+2OBqaIg8L4h1i84nuqLeEqX/rwxL6PprCpF2dzyhW0msKBbcvL+zAneKxZC56dQPasGtg4BbfBTMWQilJpl57qpTf08Lw+Ck6RVAuU3N2Huddjx9P9XGpKiN3LhyjphEtua/XzaMixS5NMuH/D4U08KG+B+JsRNsotvXv+7ZliyYJHnr3QfI0+1Y1koRmCp2t6HMYwR1jugFU7tQozEqMJz/WNKZukNW47Tv7a25i4Ja7P28Ox4BsyjKxoT9nLazNXKvT62Aew5s/zgsZDzb6eSrATAeCwcPjkp22lNM5DV10f0f0itkVXYESLfrDXgCIPO/0OqDoxvt4nWST16pUAtj1++ImNYhzaRZVdpN',
  },
  {
    name: 'multi-byte UTF-8 text and AAD',
    keyBase64: 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=',
    aad: 'ligue:Montréal:🎴',
    plaintextHex: '506f6bc3a96d6f6e20e3839de382b1e383a2e383b320f09f838f20726566726573682d746f6b656e',
    blobBase64:
      'AVVVVVVVVVVVVVVVVRqgGlJGVNHpD1flRjcGuizQJpYw8Yjtj6iA6nYy73fVjCg1v/vypoiynRGlJXkep1A7Be4EijOK',
  },
  {
    name: "attendance's golden blob",
    keyBase64: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
    aad: 'default',
    plaintextHex: '6f72795f72745f676f6c64656e2d726566726573682d746f6b656e',
    blobBase64: 'AbfWiVVN/vKVhQd5fhK97rvVWexlQ/aJWBkQm0/HHmiMFV/pGXag4c/7v87dxW5W8JFbEplJMVk=',
  },
]);
