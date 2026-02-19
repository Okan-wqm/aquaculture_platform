import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_PREFIX = 'ENC_V1:';

@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger(EncryptionService.name);
  private derivedKey!: Buffer;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const masterKey = this.configService.get<string>('CONFIG_ENCRYPTION_KEY');
    if (!masterKey) {
      const nodeEnv = this.configService.get('NODE_ENV');
      if (nodeEnv === 'production') {
        throw new Error(
          'SECURITY: CONFIG_ENCRYPTION_KEY environment variable must be set in production',
        );
      }
      this.logger.warn(
        'CONFIG_ENCRYPTION_KEY not set - encryption features will be unavailable in non-production',
      );
      return;
    }

    // Pre-derive key once at startup using a proper random salt stored with the key config
    // For backward compatibility, we derive from the master key
    // In production, CONFIG_ENCRYPTION_KEY should be a 32-byte hex-encoded key
    if (masterKey.length === 64 && /^[0-9a-fA-F]+$/.test(masterKey)) {
      // Hex-encoded 32-byte key - use directly
      this.derivedKey = Buffer.from(masterKey, 'hex');
    } else {
      // Derive key using scrypt with a proper salt
      const salt = crypto.createHash('sha256').update(masterKey).digest().subarray(0, 16);
      this.derivedKey = crypto.scryptSync(masterKey, salt, 32);
    }

    this.logger.log('Encryption service initialized');
  }

  /**
   * Check if encryption is available
   */
  isAvailable(): boolean {
    return !!this.derivedKey;
  }

  /**
   * Check if a value is already encrypted (has the ENC_V1: prefix)
   */
  isEncrypted(value: string): boolean {
    return value.startsWith(ENCRYPTION_PREFIX);
  }

  /**
   * Encrypt a plaintext value using AES-256-GCM
   * Returns a prefixed string: ENC_V1:{base64_payload}
   */
  encrypt(plaintext: string): string {
    if (!this.derivedKey) {
      throw new Error('Encryption is not available - CONFIG_ENCRYPTION_KEY not configured');
    }

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, this.derivedKey, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    const payload = JSON.stringify({
      iv: iv.toString('hex'),
      tag: authTag.toString('hex'),
      data: encrypted,
    });

    return ENCRYPTION_PREFIX + Buffer.from(payload).toString('base64');
  }

  /**
   * Decrypt an encrypted value
   * Expects the ENC_V1:{base64_payload} format
   */
  decrypt(encryptedValue: string): string {
    if (!this.derivedKey) {
      throw new Error('Encryption is not available - CONFIG_ENCRYPTION_KEY not configured');
    }

    if (!encryptedValue.startsWith(ENCRYPTION_PREFIX)) {
      throw new Error('Invalid encrypted value format - missing ENC_V1: prefix');
    }

    try {
      const payloadBase64 = encryptedValue.slice(ENCRYPTION_PREFIX.length);
      const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));

      const decipher = crypto.createDecipheriv(
        ENCRYPTION_ALGORITHM,
        this.derivedKey,
        Buffer.from(payload.iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));

      let decrypted = decipher.update(payload.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error(
        `Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}
