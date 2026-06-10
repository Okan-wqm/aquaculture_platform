import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_PREFIX_V1 = 'ENC_V1:';
const ENCRYPTION_PREFIX_V2 = 'ENC_V2:';

export interface EncryptionAadContext {
  tenantId: string;
  service: string;
  key: string;
  environment: string;
  classification: string;
  contextVersion?: number;
}

interface LegacyEncryptionPayload {
  salt: string;
  iv: string;
  tag: string;
  data: string;
  aadTenantId?: string;
  aadConfigKey?: string;
  aadContext?: EncryptionAadContext;
}

/**
 * NIST SP 800-38D compliant AES-256-GCM encryption service.
 *
 * V2 format fixes three compounding cryptographic weaknesses from V1:
 * - PLAT-HIGH-001: Per-secret random 32-byte salt (defeats precomputation attacks)
 * - PLAT-HIGH-002: 12-byte IV (NIST-mandated 96-bit, not 16-byte)
 * - PLAT-HIGH-003: AAD binding to tenantId+configKey (prevents ciphertext relocation)
 *
 * V1 values are still decryptable for backward compatibility. On read, V1 values
 * should be re-encrypted as V2 (caller responsibility via getAndUpgrade pattern).
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger(EncryptionService.name);
  /** Pre-derived key for V1 backward compatibility */
  private derivedKeyV1!: Buffer;
  /** Raw master key for V2 per-secret scrypt derivation */
  private masterKey!: string;
  private available = false;

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

    this.masterKey = masterKey;

    // ── V1 backward-compat key derivation ──
    if (masterKey.length === 64 && /^[0-9a-fA-F]+$/.test(masterKey)) {
      this.derivedKeyV1 = Buffer.from(masterKey, 'hex');
    } else {
      const salt = Buffer.from('aquaculture-config-encryption-v1', 'utf8').subarray(0, 16);
      this.derivedKeyV1 = crypto.scryptSync(masterKey, salt, 32);
    }

    this.available = true;
    this.logger.log('Encryption service initialized (V2 with per-secret salt + AAD)');
  }

  /**
   * Check if encryption is available
   */
  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Check if a value is already encrypted (has the ENC_V1: or ENC_V2: prefix)
   */
  isEncrypted(value: string): boolean {
    return value.startsWith(ENCRYPTION_PREFIX_V1) || value.startsWith(ENCRYPTION_PREFIX_V2);
  }

  // ── V2 Encryption (current) ────────────────────────────────────────────

  /**
   * Encrypt a plaintext value using AES-256-GCM with NIST-compliant parameters.
   *
   * SECURITY:
   * - 32-byte random salt per secret (defeats precomputation / rainbow tables)
   * - 12-byte IV (NIST SP 800-38D mandated 96-bit for AES-GCM)
   * - AAD binds ciphertext to tenantId+configKey (prevents cross-tenant relocation)
   *
   * @param plaintext - The value to encrypt
   * @param tenantId - Tenant context for AAD binding
   * @param configKey - Config key for AAD binding
   * @returns Prefixed string: ENC_V2:{base64_payload}
   */
  encrypt(
    plaintext: string,
    contextOrTenantId?: EncryptionAadContext | string,
    configKey?: string,
  ): string {
    if (!this.available) {
      throw new Error('Encryption is not available - CONFIG_ENCRYPTION_KEY not configured');
    }

    // PLAT-HIGH-001: Random 32-byte salt per secret
    const salt = crypto.randomBytes(32);

    // Derive per-secret key using scrypt(masterKey, randomSalt)
    const derivedKey = crypto.scryptSync(this.masterKey, salt, 32);

    // PLAT-HIGH-002: 12-byte IV (96-bit) per NIST SP 800-38D
    const iv = crypto.randomBytes(12);

    const aadContext = this.normalizeContext(contextOrTenantId, configKey);
    const aad = this.buildAad(aadContext);

    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv);
    if (aad.length > 0) {
      cipher.setAAD(aad);
    }

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    const payload = JSON.stringify({
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: authTag.toString('hex'),
      data: encrypted,
      aadTenantId: aadContext?.tenantId || '',
      aadConfigKey: aadContext?.key || '',
      aadContext,
    });

    return ENCRYPTION_PREFIX_V2 + Buffer.from(payload).toString('base64');
  }

  /**
   * Decrypt an encrypted value.
   * Supports both ENC_V1 (legacy) and ENC_V2 (current) formats.
   *
   * For ENC_V2, the AAD is reconstructed from the stored payload. If tenantId
   * and configKey are provided, they are validated against the stored AAD to
   * detect ciphertext relocation attacks.
   *
   * @param encryptedValue - The encrypted string (ENC_V1:... or ENC_V2:...)
   * @param tenantId - Optional: validate AAD tenant binding
   * @param configKey - Optional: validate AAD config key binding
   */
  decrypt(
    encryptedValue: string,
    contextOrTenantId?: EncryptionAadContext | string,
    configKey?: string,
  ): string {
    if (!this.available) {
      throw new Error('Encryption is not available - CONFIG_ENCRYPTION_KEY not configured');
    }

    if (encryptedValue.startsWith(ENCRYPTION_PREFIX_V2)) {
      return this.decryptV2(
        encryptedValue,
        this.normalizeContext(contextOrTenantId, configKey),
      );
    }

    if (encryptedValue.startsWith(ENCRYPTION_PREFIX_V1)) {
      return this.decryptV1(encryptedValue);
    }

    throw new Error('Invalid encrypted value format - missing ENC_V1: or ENC_V2: prefix');
  }

  // ── V2 Decrypt ────────────────────────────────────────────────────────

  private decryptV2(
    encryptedValue: string,
    callerContext?: EncryptionAadContext,
  ): string {
    try {
      const payloadBase64 = encryptedValue.slice(ENCRYPTION_PREFIX_V2.length);
      const payload = JSON.parse(
        Buffer.from(payloadBase64, 'base64').toString('utf8'),
      ) as LegacyEncryptionPayload;

      // SECURITY: Validate AAD context if caller provides it
      this.validateAadContext(payload, callerContext);

      const salt = Buffer.from(payload.salt, 'hex');
      const iv = Buffer.from(payload.iv, 'hex');
      const authTag = Buffer.from(payload.tag, 'hex');

      // Derive key using stored salt
      const derivedKey = crypto.scryptSync(this.masterKey, salt, 32);

      const aad = this.buildAad(this.payloadContext(payload));

      const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, derivedKey, iv);
      decipher.setAuthTag(authTag);
      if (aad.length > 0) {
        decipher.setAAD(aad);
      }

      let decrypted = decipher.update(payload.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('AAD mismatch')) {
        throw error;
      }
      throw new Error(
        `Decryption failed (V2): ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  // ── V1 Decrypt (backward compatibility) ───────────────────────────────

  private decryptV1(encryptedValue: string): string {
    try {
      const payloadBase64 = encryptedValue.slice(ENCRYPTION_PREFIX_V1.length);
      const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));

      const decipher = crypto.createDecipheriv(
        ENCRYPTION_ALGORITHM,
        this.derivedKeyV1,
        Buffer.from(payload.iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));

      let decrypted = decipher.update(payload.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error(
        `Decryption failed (V1): ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Build Additional Authenticated Data buffer from tenant context.
   * AAD ensures ciphertext cannot be moved between tenants/keys without detection.
   */
  private normalizeContext(
    contextOrTenantId?: EncryptionAadContext | string,
    configKey?: string,
  ): EncryptionAadContext | undefined {
    if (!contextOrTenantId) return undefined;
    if (typeof contextOrTenantId !== 'string') {
      return {
        contextVersion: 2,
        ...contextOrTenantId,
      };
    }
    return {
      contextVersion: 1,
      tenantId: contextOrTenantId,
      service: '',
      key: configKey ?? '',
      environment: '',
      classification: '',
    };
  }

  private payloadContext(payload: LegacyEncryptionPayload): EncryptionAadContext | undefined {
    if (payload.aadContext) return payload.aadContext;
    return this.normalizeContext(payload.aadTenantId, payload.aadConfigKey);
  }

  private validateAadContext(
    payload: LegacyEncryptionPayload,
    callerContext?: EncryptionAadContext,
  ): void {
    if (!callerContext) return;

    const storedContext = this.payloadContext(payload);
    if (!storedContext) return;

    for (const key of ['tenantId', 'service', 'key', 'environment', 'classification'] as const) {
      const expected = storedContext[key];
      const actual = callerContext[key];
      if (expected && actual && expected !== actual) {
        throw new Error(
          `AAD mismatch: ciphertext was encrypted for a different ${key}.`,
        );
      }
    }
  }

  private buildAad(context?: EncryptionAadContext): Buffer {
    if (!context) {
      return Buffer.alloc(0);
    }
    if ((context.contextVersion ?? 1) === 1) {
      return Buffer.from(`${context.tenantId || ''}:${context.key || ''}`, 'utf8');
    }
    const aadString = [
      context.contextVersion ?? 1,
      context.tenantId || '',
      context.service || '',
      context.key || '',
      context.environment || '',
      context.classification || '',
    ].join(':');
    return Buffer.from(aadString, 'utf8');
  }
}
