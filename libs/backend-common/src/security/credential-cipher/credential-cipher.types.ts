/** Environment variable containing the path to the credential keyring file. */
export const CREDENTIAL_CIPHER_KEYRING_FILE_ENV = 'CREDENTIAL_CIPHER_KEYRING_FILE' as const;

/** Environment variable selecting the sole key used for new ciphertext writes. */
export const CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV = 'CREDENTIAL_CIPHER_ACTIVE_KEY_ID' as const;

/** Current credential-cipher envelope and keyring format version. */
export const CREDENTIAL_CIPHER_FORMAT_VERSION = 1 as const;

/** Hard storage/parser ceiling for a serialized credential envelope. */
export const CREDENTIAL_CIPHER_MAX_ENVELOPE_CHARACTERS = 128 * 1024;

/** Protocol sizes shared by envelope generation and its plaintext ceiling. */
export const CREDENTIAL_CIPHER_IV_BYTES = 12;
export const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
export const CREDENTIAL_CIPHER_MAX_KEY_ID_CHARACTERS = 64;

function base64UrlEncodedCharacters(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

const ENVELOPE_FIXED_CHARACTERS =
  'cred'.length +
  `v${CREDENTIAL_CIPHER_FORMAT_VERSION}`.length +
  CREDENTIAL_CIPHER_MAX_KEY_ID_CHARACTERS +
  base64UrlEncodedCharacters(CREDENTIAL_CIPHER_IV_BYTES) +
  base64UrlEncodedCharacters(CREDENTIAL_CIPHER_AUTH_TAG_BYTES) +
  5; // Five ':' separators across the six envelope parts.

/**
 * Largest UTF-8 plaintext that always produces an envelope accepted by our
 * own 128 KiB parser, including the worst-case 64-character key identifier.
 */
export const CREDENTIAL_CIPHER_MAX_PLAINTEXT_BYTES = Math.floor(
  ((CREDENTIAL_CIPHER_MAX_ENVELOPE_CHARACTERS - ENVELOPE_FIXED_CHARACTERS) * 3) / 4,
);

/**
 * Context authenticated with every provider credential.
 *
 * All fields are required deliberately. A caller cannot decrypt a ciphertext
 * after moving it to another tenant, table, row, provider, purpose, or
 * credential generation.
 */
export interface CredentialCipherAad {
  tenantId: string;
  table: string;
  rowId: string;
  provider: string;
  purpose: string;
  credentialGeneration: number;
}

/** Ciphertext plus the denormalized key identifier persisted beside it. */
export interface CredentialCipherEncryptedValue {
  envelope: string;
  keyId: string;
}

/** Result of explicitly moving an envelope onto the configured active key. */
export interface CredentialCipherReencryptResult {
  envelope: string;
  oldKeyId: string;
  newKeyId: string;
  changed: boolean;
}
