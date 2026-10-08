import * as crypto from 'crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import {
  runInSourceRead,
  runInTenantRead,
  runInTenantTransaction,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, DataSource } from 'typeorm';

import { CreateTenantKeyInput, TenantKeyResponse } from './dto/provisioning.dto';
import { TenantProvisioningKeyDirectory } from './entities/tenant-provisioning-key-directory.entity';
import { TenantProvisioningKey } from './entities/tenant-provisioning-key.entity';
import { InstallerScriptService } from './installer-script.service';

/**
 * Domain separator for the provisioning-key route hash. The route is
 * sha256(prefix || sha256(rawKey)): derivable from the at-rest digest (so a
 * migration can backfill it) but never equal to it.
 */
export const PROVISIONING_KEY_ROUTE_PREFIX = 'sensor-provisioning-key-route:';

/** Route hash of a provisioning key, from its at-rest sha256 hex digest. */
export function provisioningKeyRouteHash(keyDigestHex: string): string {
  return crypto
    .createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from(PROVISIONING_KEY_ROUTE_PREFIX, 'utf8'),
        Buffer.from(keyDigestHex, 'hex'),
      ]),
    )
    .digest('hex');
}

/**
 * Tenant Key Service
 * Manages tenant-level provisioning keys that allow multiple devices
 * to self-register with a single installer link.
 */
@Injectable()
export class TenantKeyService {
  private readonly logger = new Logger(TenantKeyService.name);

  constructor(
    @InjectRepository(TenantProvisioningKey)
    private readonly tenantKeyRepository: Repository<TenantProvisioningKey>,
    private readonly installerScriptService: InstallerScriptService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Resolve a presented key to its row (SENSOR-HIGH-027 / SENSOR-HIGH-175).
   *
   * The public self-register / installer endpoints have no tenant. The key's
   * route (`sensor.tenant_provisioning_key_directory`, read through
   * runInSourceRead) names the tenant; the key row is then read inside THAT
   * tenant's runInTenantRead by its at-rest digest. A route miss, or a route
   * naming a tenant that does not hold the key, resolves nothing. The pooled
   * UNION over every tenant schema that used to do this saw zero rows under
   * FORCE RLS, so no key was ever found.
   */
  private async findKeyByDigest(tokenHash: string): Promise<TenantProvisioningKey | null> {
    const rows = (await runInSourceRead(this.dataSource, 'sensor', (qr) =>
      qr.query(`SELECT tenant_id FROM tenant_provisioning_key_directory WHERE route_hash = $1`, [
        provisioningKeyRouteHash(tokenHash),
      ]),
    )) as Array<{ tenant_id: string }>;
    const route = rows[0];
    if (route === undefined) {
      return null;
    }
    return runInTenantRead(this.dataSource, 'sensor', route.tenant_id, (qr) =>
      tenantManagerRepo(qr.manager, TenantProvisioningKey).findOne({
        where: { keyToken: tokenHash },
      }),
    );
  }

  /**
   * SENSOR-MEDIUM-001: hash a provisioning key for at-rest storage / lookup.
   * The raw key is a 256-bit crypto-random value, so a plain SHA-256 is
   * sufficient to make a DB leak non-replayable while fitting the existing
   * `varchar(64)` column (SHA-256 hex = 64 chars).
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Create a tenant-level provisioning key
   * Allows multiple devices to self-register with a single installer link
   */
  async createTenantKey(
    tenantId: string,
    input: CreateTenantKeyInput,
    createdBy: string,
  ): Promise<TenantKeyResponse> {
    const keyToken = crypto.randomBytes(32).toString('hex');

    let expiresAt: Date | undefined;
    if (input.expiresInDays) {
      expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
    }

    const key = this.tenantKeyRepository.create({
      tenantId,
      keyToken: this.hashToken(keyToken),
      name: input.name,
      isActive: true,
      maxDevices: input.maxDevices,
      usedCount: 0,
      autoApprove: input.autoApprove ?? false,
      defaultSiteId: input.defaultSiteId,
      expiresAt,
      createdBy,
    });

    // SENSOR-HIGH-175: the key row and its route commit in one tenant
    // transaction — the public endpoints find a key only through its route.
    const saved = await runInTenantTransaction(this.dataSource, 'sensor', tenantId, async (qr) => {
      const persisted = await tenantManagerRepo(qr.manager, TenantProvisioningKey).save(key);
      await qr.manager.insert(TenantProvisioningKeyDirectory, {
        routeHash: provisioningKeyRouteHash(persisted.keyToken),
        keyId: persisted.id,
        tenantId,
      });
      return persisted;
    });
    this.logger.log(`Created tenant provisioning key ${saved.id} for tenant ${tenantId}`);

    // Surface the PLAINTEXT key exactly once. `saved.keyToken` is the digest at
    // rest; the installer link and the one-time response carry the raw value.
    return {
      id: saved.id,
      keyToken,
      installerUrl: await this.installerScriptService.buildTenantInstallerUrl(),
      installerCommand: await this.installerScriptService.buildTenantInstallerCommand(keyToken),
      expiresAt: saved.expiresAt,
      maxDevices: saved.maxDevices,
      autoApprove: saved.autoApprove,
    };
  }

  /**
   * Revoke a tenant provisioning key
   */
  async revokeTenantKey(keyId: string, tenantId: string): Promise<boolean> {
    // Revocation lives on the tenant row (is_active), which validateAndGetKey
    // reads inside the tenant boundary; the route stays so a revoked key is
    // reported as revoked, not as unknown. No other writer touches keys:
    // creation (createTenantKey), revocation (here) and the used-count claim
    // (incrementUsedCount) are the whole set; expiry is decided at read time.
    await runInTenantTransaction(this.dataSource, 'sensor', tenantId, async (qr) => {
      const keys = tenantManagerRepo(qr.manager, TenantProvisioningKey);
      const key = await keys.findOne({ where: { id: keyId } });
      if (!key) {
        throw new NotFoundException(`Provisioning key ${keyId} not found`);
      }
      key.isActive = false;
      await keys.save(key);
    });
    this.logger.log(`Revoked tenant provisioning key ${keyId}`);
    return true;
  }

  /**
   * List all provisioning keys for a tenant
   */
  async listTenantKeys(tenantId: string): Promise<TenantProvisioningKey[]> {
    return this.tenantKeyRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Validate a tenant provisioning key token and return the key if valid.
   * Throws appropriate HTTP exceptions if the key is invalid, revoked, expired, or at capacity.
   */
  async validateAndGetKey(token: string): Promise<TenantProvisioningKey> {
    // SENSOR-MEDIUM-001: the column stores sha256(rawKey); resolve by digest.
    const tokenHash = this.hashToken(token);
    // SENSOR-HIGH-175: route → owning tenant's boundary; a miss denies.
    const key = await this.findKeyByDigest(tokenHash);

    if (!key) {
      throw new NotFoundException('Invalid installer token');
    }

    // Constant-time comparison over the fixed-width digests (both 32 bytes),
    // defeating any timing oracle on the resolved row.
    const storedBuf = Buffer.from(key.keyToken, 'hex');
    const inboundBuf = Buffer.from(tokenHash, 'hex');
    if (storedBuf.length !== inboundBuf.length || !crypto.timingSafeEqual(storedBuf, inboundBuf)) {
      throw new NotFoundException('Invalid installer token');
    }

    if (!key.isActive) {
      throw new BadRequestException('This installer key has been revoked');
    }

    if (key.expiresAt && key.expiresAt < new Date()) {
      throw new UnauthorizedException('This installer key has expired');
    }

    if (key.maxDevices && key.usedCount >= key.maxDevices) {
      throw new ConflictException('Maximum device limit reached for this key');
    }

    return key;
  }

  /**
   * Claim one registration on a key, atomically, inside the registering
   * transaction. The claim re-checks everything validateAndGetKey checked —
   * active, not expired, under max_devices — in the same UPDATE, so a key
   * revoked, expired or exhausted between validation and registration claims
   * nothing and the registration rolls back (TOCTOU). Exactly one row must be
   * claimed.
   */
  async incrementUsedCount(keyId: string, transactionalManager: EntityManager): Promise<void> {
    const result = await transactionalManager
      .createQueryBuilder()
      .update(TenantProvisioningKey)
      .set({ usedCount: () => '"used_count" + 1' })
      .where(
        'id = :id AND "is_active" AND ("expires_at" IS NULL OR "expires_at" > now()) ' +
          'AND ("max_devices" IS NULL OR "used_count" < "max_devices")',
        { id: keyId },
      )
      .execute();

    if (result.affected !== 1) {
      throw new ConflictException(
        'This installer key can no longer register devices (revoked, expired or at its limit)',
      );
    }
  }
}
