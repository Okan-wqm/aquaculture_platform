import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ENCRYPTION_KEY } from './credential-vault.constants';
import {
  DEV_FALLBACK_KEY,
  decryptSecretValue,
  encryptSecretValue,
  isEncryptedValue,
  resolveEncryptionKey,
} from './credential-crypto';

/**
 * Runtime holder for the AES-256-GCM credential key. The actual crypto lives in
 * `credential-crypto.ts` (shared with the offline backfill migration); this
 * service owns key resolution from config + the fail-in-production posture.
 */
@Injectable()
export class CredentialVaultService implements OnModuleInit {
  private readonly logger = new Logger(CredentialVaultService.name);
  private encryptionKey!: Buffer;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const rawKey = this.configService.get<string>(ENCRYPTION_KEY);
    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';

    const resolved = resolveEncryptionKey(rawKey);
    if (!resolved) {
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

    this.encryptionKey = resolved;
    this.logger.log('[CredentialVault] Encryption key loaded successfully.');
  }

  /**
   * Encrypts a plaintext string using AES-256-GCM.
   * Returns a string in the format: `enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>`
   */
  encrypt(plaintext: string): string {
    return encryptSecretValue(plaintext, this.encryptionKey);
  }

  /**
   * Decrypts a value encrypted by `encrypt()`.
   * If the value does not start with `enc:`, it is returned as-is (backward
   * compatibility for existing plaintext data stored before encryption was added).
   */
  decrypt(encrypted: string): string {
    return decryptSecretValue(encrypted, this.encryptionKey);
  }

  /**
   * Returns true if the value was encrypted by this service
   * (i.e. starts with the `enc:` prefix).
   */
  isEncrypted(value: string): boolean {
    return isEncryptedValue(value);
  }
}
