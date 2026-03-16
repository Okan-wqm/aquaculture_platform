import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  ENCRYPTION_KEY,
  ENCRYPTION_ALGORITHM,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
  ENCRYPTED_PREFIX,
} from './credential-vault.constants';

/** AES-256-GCM key must be exactly 32 bytes */
const KEY_LENGTH = 32;

/**
 * Deterministic dev-only key — never used in production.
 * 32 bytes of ASCII 'd' (0x64) repeated.
 */
const DEV_FALLBACK_KEY = 'd'.repeat(KEY_LENGTH);

@Injectable()
export class CredentialVaultService implements OnModuleInit {
  private readonly logger = new Logger(CredentialVaultService.name);
  private encryptionKey!: Buffer;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const rawKey = this.configService.get<string>(ENCRYPTION_KEY);
    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';

    if (!rawKey) {
      if (isProduction) {
        throw new Error(
          `[CredentialVault] ${ENCRYPTION_KEY} environment variable is required in production. ` +
            'Set a 32-byte (64 hex character) AES-256 key before starting the service.',
        );
      }

      this.logger.warn(
        `[CredentialVault] ${ENCRYPTION_KEY} is not set. ` +
          'Using insecure dev-only fallback key. DO NOT use this in production.',
      );
      this.encryptionKey = Buffer.from(DEV_FALLBACK_KEY, 'utf8');
      return;
    }

    // Accept hex-encoded 32-byte key (64 hex chars) or raw 32-char ASCII key
    if (rawKey.length === KEY_LENGTH * 2 && /^[0-9a-fA-F]+$/.test(rawKey)) {
      this.encryptionKey = Buffer.from(rawKey, 'hex');
    } else if (rawKey.length === KEY_LENGTH) {
      this.encryptionKey = Buffer.from(rawKey, 'utf8');
    } else {
      throw new Error(
        `[CredentialVault] ${ENCRYPTION_KEY} must be either a 32-character ASCII string ` +
          'or a 64-character hex-encoded value.',
      );
    }

    this.logger.log('[CredentialVault] Encryption key loaded successfully.');
  }

  /**
   * Encrypts a plaintext string using AES-256-GCM.
   * Returns a string in the format: `enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>`
   */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(
      ENCRYPTION_ALGORITHM,
      this.encryptionKey,
      iv,
    ) as crypto.CipherGCM;

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return (
      ENCRYPTED_PREFIX +
      iv.toString('hex') +
      ':' +
      authTag.toString('hex') +
      ':' +
      encrypted.toString('hex')
    );
  }

  /**
   * Decrypts a value encrypted by `encrypt()`.
   * If the value does not start with `enc:`, it is returned as-is (backward
   * compatibility for existing plaintext data stored before encryption was added).
   */
  decrypt(encrypted: string): string {
    if (!this.isEncrypted(encrypted)) {
      return encrypted;
    }

    const withoutPrefix = encrypted.slice(ENCRYPTED_PREFIX.length);
    const parts = withoutPrefix.split(':');

    if (parts.length !== 3) {
      throw new Error(
        '[CredentialVault] Malformed encrypted value: expected format enc:<iv>:<authTag>:<ciphertext>',
      );
    }

    const [ivHex, authTagHex, ciphertextHex] = parts as [string, string, string];
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');

    const decipher = crypto.createDecipheriv(
      ENCRYPTION_ALGORITHM,
      this.encryptionKey,
      iv,
    ) as crypto.DecipherGCM;

    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Returns true if the value was encrypted by this service
   * (i.e. starts with the `enc:` prefix).
   */
  isEncrypted(value: string): boolean {
    return value.startsWith(ENCRYPTED_PREFIX);
  }
}
