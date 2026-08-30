import * as crypto from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { TenantPayloadKey } from './entities/tenant-payload-key.entity';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const ENC_PREFIX = 'enc:';
const KEY_VERSION = '1';

/** Raised on decrypt when the tenant's DEK has been crypto-shredded (GDPR erased). */
export class TenantPayloadShreddedError extends Error {
  constructor(public readonly tenantId: string) {
    super(`event-store payload for tenant ${tenantId} is crypto-shredded (key destroyed)`);
    this.name = 'TenantPayloadShreddedError';
  }
}

/**
 * Per-tenant payload crypto for event-store crypto-shred (DB-INFRA-HIGH-003 Part B —
 * docs/plans/2026-07-12-event-store-crypto-shred-design.md).
 *
 * Envelope encryption: a random per-tenant DEK (AES-256-GCM) encrypts payloads;
 * the DEK is stored WRAPPED by the master KEK (env, never persisted). GDPR
 * erasure calls shred(), which destroys the DEK — every payload encrypted under
 * it becomes permanently unrecoverable while the immutable event envelope
 * survives.
 *
 * NOTE: not yet wired into the live append/read path — that rollout is gated on
 * security review (see the design doc). This core is proven in isolation first
 * because mis-encrypting a live event-sourcing write path corrupts replay.
 */
@Injectable()
export class TenantPayloadCryptoService {
  private readonly logger = new Logger(TenantPayloadCryptoService.name);
  /** Unwrapped DEK cache; evicted on shred. */
  private readonly dekCache = new Map<string, Buffer>();
  private kek: Buffer | null = null;

  constructor(
    @InjectRepository(TenantPayloadKey)
    private readonly keyRepo: Repository<TenantPayloadKey>,
    private readonly config: ConfigService,
  ) {}

  /** Encrypt plaintext under the tenant's DEK (creating the DEK on first use). */
  async encrypt(tenantId: string, plaintext: string): Promise<string> {
    const dek = await this.getOrCreateDek(tenantId);
    return this.aesEncrypt(plaintext, dek);
  }

  /**
   * Decrypt a value produced by encrypt(). Pre-encryption plaintext (no `enc:`
   * prefix) passes through. Throws TenantPayloadShreddedError if the tenant key
   * has been destroyed.
   */
  async decrypt(tenantId: string, value: string): Promise<string> {
    if (!value.startsWith(ENC_PREFIX)) {
      return value; // legacy plaintext (pre-encryption backward-compat)
    }
    const dek = await this.getExistingDek(tenantId);
    if (!dek) {
      throw new TenantPayloadShreddedError(tenantId);
    }
    return this.aesDecrypt(value, dek);
  }

  /**
   * Crypto-shred a tenant: overwrite the wrapped DEK with random bytes and stamp
   * shredded_at, so the DEK can never be unwrapped again. Idempotent — a
   * non-existent or already-shredded tenant is a no-op.
   */
  async shred(tenantId: string): Promise<void> {
    const row = await this.keyRepo.findOne({ where: { tenantId } });
    this.dekCache.delete(tenantId);
    if (!row || row.shreddedAt) {
      return;
    }
    // Overwrite the wrapped DEK with unrecoverable random data (not just NULL) so
    // even a point-in-time DB backup taken after this cannot recover the key.
    row.wrappedDek = `shredded:${crypto.randomBytes(48).toString('hex')}`;
    row.shreddedAt = new Date();
    await this.keyRepo.save(row);
    this.logger.log(`crypto-shredded event-store payload key for tenant ${tenantId}`);
  }

  /** True once the tenant's key has been destroyed. */
  async isShredded(tenantId: string): Promise<boolean> {
    const row = await this.keyRepo.findOne({ where: { tenantId } });
    return !!row?.shreddedAt;
  }

  /* ---------------------------------------------------------------- */
  /*  DEK lifecycle                                                    */
  /* ---------------------------------------------------------------- */

  private async getOrCreateDek(tenantId: string): Promise<Buffer> {
    const cached = this.dekCache.get(tenantId);
    if (cached) return cached;

    const existing = await this.keyRepo.findOne({ where: { tenantId } });
    if (existing) {
      if (existing.shreddedAt) {
        throw new TenantPayloadShreddedError(tenantId);
      }
      const dek = this.unwrapDek(existing.wrappedDek);
      this.dekCache.set(tenantId, dek);
      return dek;
    }

    // First use — mint a fresh DEK and store it wrapped. Guard the insert race
    // (another append for the same tenant) with an ON CONFLICT re-read.
    const dek = crypto.randomBytes(KEY_LENGTH);
    const wrapped = this.aesEncrypt(dek.toString('hex'), this.getKek());
    const inserted = await this.keyRepo
      .createQueryBuilder()
      .insert()
      .into(TenantPayloadKey)
      .values({ tenantId, wrappedDek: wrapped, keyVersion: 1 })
      .orIgnore()
      .execute();
    if (inserted.identifiers.length === 0) {
      // Lost the race — re-read the winner's key.
      return this.getOrCreateDek(tenantId);
    }
    this.dekCache.set(tenantId, dek);
    return dek;
  }

  private async getExistingDek(tenantId: string): Promise<Buffer | null> {
    const cached = this.dekCache.get(tenantId);
    if (cached) return cached;
    const row = await this.keyRepo.findOne({
      where: { tenantId, shreddedAt: IsNull() },
    });
    if (!row) return null;
    const dek = this.unwrapDek(row.wrappedDek);
    this.dekCache.set(tenantId, dek);
    return dek;
  }

  private unwrapDek(wrapped: string): Buffer {
    return Buffer.from(this.aesDecrypt(wrapped, this.getKek()), 'hex');
  }

  private getKek(): Buffer {
    if (this.kek) return this.kek;
    const raw = this.config.get<string>('EVENT_STORE_PAYLOAD_KEK');
    const nodeEnv = this.config.get<string>('NODE_ENV');
    if (!raw) {
      if (nodeEnv === 'development' || nodeEnv === 'test') {
        this.kek = Buffer.from('k'.repeat(KEY_LENGTH), 'utf8');
        return this.kek;
      }
      throw new Error(
        'EVENT_STORE_PAYLOAD_KEK is required in production for event-store crypto-shred',
      );
    }
    // 64-hex-char => 32 raw bytes; otherwise treat as a 32-byte utf8 secret.
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'utf8');
    if (key.length !== KEY_LENGTH) {
      throw new Error(`EVENT_STORE_PAYLOAD_KEK must be 32 bytes (got ${key.length})`);
    }
    this.kek = key;
    return key;
  }

  /* ---------------------------------------------------------------- */
  /*  AES-256-GCM (same envelope format as the platform primitive)     */
  /* ---------------------------------------------------------------- */

  private aesEncrypt(plaintext: string, key: Buffer): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv) as crypto.CipherGCM;
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENC_PREFIX}${KEY_VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
  }

  private aesDecrypt(value: string, key: Buffer): string {
    const parts = value.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 4) {
      throw new Error('malformed encrypted value: expected enc:<v>:<iv>:<tag>:<ct>');
    }
    const [, ivHex, tagHex, ctHex] = parts as [string, string, string, string];
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(ivHex, 'hex'),
    ) as crypto.DecipherGCM;
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString(
      'utf8',
    );
  }
}
