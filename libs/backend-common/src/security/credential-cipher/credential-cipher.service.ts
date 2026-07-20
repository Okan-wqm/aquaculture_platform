import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { buildCredentialCipherAad } from './credential-cipher.aad';
import { CREDENTIAL_CIPHER_ERROR_CODES, CredentialCipherError } from './credential-cipher.errors';
import type {
  CredentialCipherAad,
  CredentialCipherEncryptedValue,
  CredentialCipherReencryptResult,
} from './credential-cipher.types';
import {
  CREDENTIAL_CIPHER_AUTH_TAG_BYTES,
  CREDENTIAL_CIPHER_FORMAT_VERSION,
  CREDENTIAL_CIPHER_IV_BYTES,
  CREDENTIAL_CIPHER_MAX_ENVELOPE_CHARACTERS,
  CREDENTIAL_CIPHER_MAX_KEY_ID_CHARACTERS,
  CREDENTIAL_CIPHER_MAX_PLAINTEXT_BYTES,
} from './credential-cipher.types';
import {
  loadCredentialCipherKeyring,
  type LoadedCredentialCipherKeyring,
} from './credential-keyring.loader';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_NAMESPACE = 'cred';
const ENVELOPE_VERSION = `v${CREDENTIAL_CIPHER_FORMAT_VERSION}` as const;
const ENVELOPE_PARTS = 6;
const KEY_ID_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9_-]{0,${CREDENTIAL_CIPHER_MAX_KEY_ID_CHARACTERS - 1}}$`,
);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

interface ParsedEnvelope {
  keyId: string;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

function decodeBase64Url(value: string, expectedBytes?: number): Buffer {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.ENVELOPE_MALFORMED);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.toString('base64url') !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    decoded.fill(0);
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.ENVELOPE_MALFORMED);
  }
  return decoded;
}

function parseEnvelope(envelope: string): ParsedEnvelope {
  if (
    typeof envelope !== 'string' ||
    envelope.length === 0 ||
    envelope.length > CREDENTIAL_CIPHER_MAX_ENVELOPE_CHARACTERS
  ) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.ENVELOPE_MALFORMED);
  }

  const parts = envelope.split(':');
  if (parts.length !== ENVELOPE_PARTS || parts[0] !== ENVELOPE_NAMESPACE) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.ENVELOPE_MALFORMED);
  }
  if (parts[1] !== ENVELOPE_VERSION) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.ENVELOPE_VERSION_UNSUPPORTED);
  }

  const keyId = parts[2];
  const ivEncoded = parts[3];
  const authTagEncoded = parts[4];
  const ciphertextEncoded = parts[5];
  if (
    keyId === undefined ||
    ivEncoded === undefined ||
    authTagEncoded === undefined ||
    ciphertextEncoded === undefined ||
    !KEY_ID_PATTERN.test(keyId)
  ) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.ENVELOPE_MALFORMED);
  }

  let iv: Buffer | undefined;
  let authTag: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  try {
    iv = decodeBase64Url(ivEncoded, CREDENTIAL_CIPHER_IV_BYTES);
    authTag = decodeBase64Url(authTagEncoded, CREDENTIAL_CIPHER_AUTH_TAG_BYTES);
    ciphertext = decodeBase64Url(ciphertextEncoded);
    return { keyId, iv, authTag, ciphertext };
  } catch (error) {
    iv?.fill(0);
    authTag?.fill(0);
    ciphertext?.fill(0);
    throw error;
  }
}

@Injectable()
export class CredentialCipherService implements OnModuleInit, OnModuleDestroy {
  private keyring?: LoadedCredentialCipherKeyring;

  /** Load and validate the complete file-backed keyring before boot succeeds. */
  onModuleInit(): void {
    this.keyring?.destroy();
    this.keyring = undefined;
    this.keyring = loadCredentialCipherKeyring();
  }

  /** Best-effort in-process zeroization when Nest tears the provider down. */
  onModuleDestroy(): void {
    this.keyring?.destroy();
    this.keyring = undefined;
  }

  activeKeyId(): string {
    return this.requireKeyring().activeKeyId;
  }

  encrypt(plaintext: string, aad: CredentialCipherAad): CredentialCipherEncryptedValue {
    if (typeof plaintext !== 'string') {
      throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.PLAINTEXT_INVALID);
    }

    const plaintextBytes = Buffer.from(plaintext, 'utf8');
    try {
      const keyring = this.requireKeyring();
      return this.encryptBytes(plaintextBytes, aad, keyring.activeKeyId, keyring.activeKey());
    } finally {
      plaintextBytes.fill(0);
    }
  }

  decrypt(envelope: string, aad: CredentialCipherAad): string {
    const parsed = parseEnvelope(envelope);
    let plaintext: Buffer | undefined;
    try {
      plaintext = this.decryptParsed(parsed, aad);
      return plaintext.toString('utf8');
    } finally {
      plaintext?.fill(0);
      parsed.iv.fill(0);
      parsed.authTag.fill(0);
      parsed.ciphertext.fill(0);
    }
  }

  /**
   * Explicitly authenticate an envelope and, when required, move it to the
   * active key. Persistence locking and generation CAS belong to the storage
   * owner; this method performs no hidden write.
   */
  reencrypt(envelope: string, aad: CredentialCipherAad): CredentialCipherReencryptResult {
    const parsed = parseEnvelope(envelope);
    const oldKeyId = parsed.keyId;
    let plaintext: Buffer | undefined;
    try {
      const keyring = this.requireKeyring();
      plaintext = this.decryptParsed(parsed, aad);
      if (oldKeyId === keyring.activeKeyId) {
        return {
          envelope,
          oldKeyId,
          newKeyId: oldKeyId,
          changed: false,
        };
      }

      const encrypted = this.encryptBytes(plaintext, aad, keyring.activeKeyId, keyring.activeKey());
      return {
        envelope: encrypted.envelope,
        oldKeyId,
        newKeyId: encrypted.keyId,
        changed: true,
      };
    } finally {
      plaintext?.fill(0);
      parsed.iv.fill(0);
      parsed.authTag.fill(0);
      parsed.ciphertext.fill(0);
    }
  }

  private requireKeyring(): LoadedCredentialCipherKeyring {
    if (!this.keyring) {
      throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.NOT_INITIALIZED);
    }
    return this.keyring;
  }

  private encryptBytes(
    plaintext: Buffer,
    aad: CredentialCipherAad,
    keyId: string,
    key: Buffer,
  ): CredentialCipherEncryptedValue {
    const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
    let authenticatedContext: Buffer | undefined;
    try {
      if (plaintext.length > CREDENTIAL_CIPHER_MAX_PLAINTEXT_BYTES) {
        throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.PLAINTEXT_TOO_LARGE);
      }
      authenticatedContext = buildCredentialCipherAad(aad, ENVELOPE_VERSION, keyId);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(authenticatedContext);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      try {
        return {
          envelope: [
            ENVELOPE_NAMESPACE,
            ENVELOPE_VERSION,
            keyId,
            iv.toString('base64url'),
            authTag.toString('base64url'),
            ciphertext.toString('base64url'),
          ].join(':'),
          keyId,
        };
      } finally {
        authTag.fill(0);
        ciphertext.fill(0);
      }
    } catch (error) {
      if (error instanceof CredentialCipherError) throw error;
      throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.ENCRYPTION_FAILED);
    } finally {
      key.fill(0);
      iv.fill(0);
      authenticatedContext?.fill(0);
    }
  }

  private decryptParsed(parsed: ParsedEnvelope, aad: CredentialCipherAad): Buffer {
    const authenticatedContext = buildCredentialCipherAad(aad, ENVELOPE_VERSION, parsed.keyId);
    let key: Buffer | undefined;
    try {
      key = this.requireKeyring().keyForRead(parsed.keyId);
      const decipher = createDecipheriv(ALGORITHM, key, parsed.iv);
      decipher.setAuthTag(parsed.authTag);
      decipher.setAAD(authenticatedContext);
      return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
    } catch (error) {
      if (error instanceof CredentialCipherError) throw error;
      throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.AUTHENTICATION_FAILED);
    } finally {
      key?.fill(0);
      authenticatedContext.fill(0);
    }
  }
}
