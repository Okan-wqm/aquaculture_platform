import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { CREDENTIAL_CIPHER_ERROR_CODES, CredentialCipherError } from './credential-cipher.errors';
import {
  CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV,
  CREDENTIAL_CIPHER_FORMAT_VERSION,
  CREDENTIAL_CIPHER_KEYRING_FILE_ENV,
} from './credential-cipher.types';

const KEY_BYTES = 32;
const MAX_KEYRING_FILE_BYTES = 64 * 1024;
// Rotation overlap is deliberately one generation: the active write key and
// at most one previous read key. Retired material must not remain a permanent
// credential authority.
const MAX_KEYRING_KEYS = 2;
const MIN_DISTINCT_KEY_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CANONICAL_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

type CredentialCipherEnvironment = Readonly<Record<string, string | undefined>>;

interface ParsedKeyEntry {
  id: string;
  key: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function parseKeyId(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEY_ID_INVALID);
  }
  return value;
}

function parseKeyMaterial(value: unknown): Buffer {
  if (typeof value !== 'string' || !CANONICAL_BASE64_PATTERN.test(value)) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEY_MATERIAL_INVALID);
  }

  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== value) {
    key.fill(0);
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEY_MATERIAL_INVALID);
  }

  if (new Set(key.values()).size < MIN_DISTINCT_KEY_BYTES) {
    key.fill(0);
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEY_MATERIAL_WEAK);
  }

  return key;
}

function parseKeyEntry(value: unknown): ParsedKeyEntry {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'keyBase64'])) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_MALFORMED);
  }

  return {
    id: parseKeyId(value['id']),
    key: parseKeyMaterial(value['keyBase64']),
  };
}

/** In-memory keyring with copied key access and explicit zeroization on stop. */
export class LoadedCredentialCipherKeyring {
  private destroyed = false;

  constructor(
    public readonly activeKeyId: string,
    private readonly keys: Map<string, Buffer>,
  ) {}

  activeKey(): Buffer {
    return this.keyForRead(this.activeKeyId);
  }

  keyForRead(keyId: string): Buffer {
    if (this.destroyed) {
      throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.NOT_INITIALIZED);
    }
    const key = this.keys.get(keyId);
    if (!key) {
      throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEY_NOT_FOUND);
    }
    return Buffer.from(key);
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    this.destroyed = true;
  }
}

/**
 * Load the credential keyring from its mandatory file path.
 *
 * The strict v1 file shape is:
 * `{ "version": 1, "keys": [{ "id": "...", "keyBase64": "..." }] }`.
 * The separately configured active key is the only write key; at most one
 * other validated entry remains read-only for the bounded rotation overlap.
 *
 * There is intentionally no inline-key environment variable and no fallback
 * when the file is absent, unreadable, malformed, or empty.
 */
export function loadCredentialCipherKeyring(
  environment: CredentialCipherEnvironment = process.env,
): LoadedCredentialCipherKeyring {
  const filePath = environment[CREDENTIAL_CIPHER_KEYRING_FILE_ENV]?.trim();
  if (!filePath) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_FILE_REQUIRED);
  }

  const activeKeyIdRaw = environment[CREDENTIAL_CIPHER_ACTIVE_KEY_ID_ENV]?.trim();
  if (!activeKeyIdRaw) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.ACTIVE_KEY_ID_REQUIRED);
  }
  const activeKeyId = parseKeyId(activeKeyIdRaw);

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_FILE_UNREADABLE);
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_KEYRING_FILE_BYTES) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_FILE_TOO_LARGE);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_MALFORMED);
  }

  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ['version', 'keys']) ||
    !Array.isArray(parsed['keys'])
  ) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_MALFORMED);
  }
  if (parsed['version'] !== CREDENTIAL_CIPHER_FORMAT_VERSION) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_VERSION_UNSUPPORTED);
  }
  if (parsed['keys'].length === 0) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_EMPTY);
  }
  if (parsed['keys'].length > MAX_KEYRING_KEYS) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEYRING_TOO_MANY_KEYS);
  }

  const keys = new Map<string, Buffer>();
  const materialFingerprints = new Set<string>();
  try {
    for (const rawEntry of parsed['keys']) {
      const entry = parseKeyEntry(rawEntry);
      if (keys.has(entry.id)) {
        entry.key.fill(0);
        throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEY_ID_DUPLICATE);
      }

      const materialFingerprint = createHash('sha256').update(entry.key).digest('hex');
      if (materialFingerprints.has(materialFingerprint)) {
        entry.key.fill(0);
        throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.KEY_MATERIAL_DUPLICATE);
      }

      keys.set(entry.id, entry.key);
      materialFingerprints.add(materialFingerprint);
    }

    if (!keys.has(activeKeyId)) {
      throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.ACTIVE_KEY_NOT_FOUND);
    }

    return new LoadedCredentialCipherKeyring(activeKeyId, keys);
  } catch (error) {
    for (const key of keys.values()) key.fill(0);
    keys.clear();
    throw error;
  }
}
