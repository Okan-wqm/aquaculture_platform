import * as crypto from 'crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, DataSource } from 'typeorm';

import {
  CreateTenantKeyInput,
  TenantKeyResponse,
} from './dto/provisioning.dto';
import { TenantProvisioningKey } from './entities/tenant-provisioning-key.entity';
import { InstallerScriptService } from './installer-script.service';

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
   * SENSOR-HIGH-027: tenant_provisioning_keys is a per-tenant table, so keys
   * created by the authenticated admin path land in `tenant_<uuid>`. But
   * validateAndGetKey is reached from PUBLIC endpoints (self-register /
   * installer) whose search_path defaults to "sensor, public", so a plain
   * repository lookup queried the empty source-schema template and every
   * legitimate token failed as "Invalid installer token".
   *
   * This mirrors the sibling `findDeviceAcrossSchemas` (edge_devices): resolve
   * the token by UNION-ALL across all tenant schemas. keyToken is a 256-bit
   * crypto-random value, so a cross-schema collision is not a practical concern
   * for the LIMIT 1 resolution.
   */
  private async findKeyAcrossSchemas(token: string): Promise<TenantProvisioningKey | null> {
    const schemas: { schema_name: string }[] = await this.dataSource.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'`,
    );
    if (schemas.length === 0) {
      return null;
    }
    // Schema names are constrained by the regex above (tenant_ + 16 hex chars).
    const unionParts = schemas.map(
      (s) => `SELECT * FROM "${s.schema_name}".tenant_provisioning_keys WHERE key_token = $1`,
    );
    const sql = `(${unionParts.join(' UNION ALL ')}) LIMIT 1`;
    const rows = await this.dataSource.query(sql, [token]);
    if (!rows || rows.length === 0) {
      return null;
    }
    return this.mapRowToKey(rows[0]);
  }

  private mapRowToKey(row: Record<string, unknown>): TenantProvisioningKey {
    const key = new TenantProvisioningKey();
    key.id = row['id'] as string;
    key.tenantId = row['tenant_id'] as string;
    key.keyToken = row['key_token'] as string;
    key.name = (row['name'] as string) ?? undefined;
    key.isActive = row['is_active'] as boolean;
    key.maxDevices = (row['max_devices'] as number) ?? undefined;
    key.usedCount = row['used_count'] as number;
    key.autoApprove = row['auto_approve'] as boolean;
    key.defaultSiteId = (row['default_site_id'] as string) ?? undefined;
    key.expiresAt = row['expires_at'] ? new Date(row['expires_at'] as string) : undefined;
    key.createdBy = (row['created_by'] as string) ?? undefined;
    key.createdAt = new Date(row['created_at'] as string);
    key.updatedAt = new Date(row['updated_at'] as string);
    return key;
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
      keyToken,
      name: input.name,
      isActive: true,
      maxDevices: input.maxDevices,
      usedCount: 0,
      autoApprove: input.autoApprove ?? false,
      defaultSiteId: input.defaultSiteId,
      expiresAt,
      createdBy,
    });

    const saved = await this.tenantKeyRepository.save(key);
    this.logger.log(`Created tenant provisioning key ${saved.id} for tenant ${tenantId}`);

    return {
      id: saved.id,
      keyToken: saved.keyToken,
      installerUrl: await this.installerScriptService.buildTenantInstallerUrl(saved.keyToken),
      installerCommand: await this.installerScriptService.buildTenantInstallerCommand(saved.keyToken),
      expiresAt: saved.expiresAt,
      maxDevices: saved.maxDevices,
      autoApprove: saved.autoApprove,
    };
  }

  /**
   * Revoke a tenant provisioning key
   */
  async revokeTenantKey(keyId: string, tenantId: string): Promise<boolean> {
    const key = await this.tenantKeyRepository.findOne({
      where: { id: keyId, tenantId },
    });

    if (!key) {
      throw new NotFoundException(`Provisioning key ${keyId} not found`);
    }

    await this.tenantKeyRepository.update(key.id, { isActive: false });
    key.isActive = false;
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
    // SENSOR-HIGH-027: resolve across tenant schemas (see findKeyAcrossSchemas).
    const key = await this.findKeyAcrossSchemas(token);

    if (!key) {
      throw new NotFoundException('Invalid installer token');
    }

    // Constant-time comparison to prevent timing oracle on token value
    const storedBuf = Buffer.from(key.keyToken);
    const inboundBuf = Buffer.from(token);
    const safeLen = Math.max(storedBuf.length, inboundBuf.length);
    const a = Buffer.concat([storedBuf, Buffer.alloc(safeLen - storedBuf.length)]);
    const b = Buffer.concat([inboundBuf, Buffer.alloc(safeLen - inboundBuf.length)]);
    if (!crypto.timingSafeEqual(a, b)) {
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
   * Atomically increment the used_count for a tenant provisioning key.
   * If maxDevices is set, only increments if used_count < max_devices (prevents TOCTOU race).
   * Throws ConflictException if the limit has been reached.
   */
  async incrementUsedCount(
    keyId: string,
    maxDevices: number | null | undefined,
    transactionalManager: EntityManager,
  ): Promise<void> {
    if (maxDevices) {
      const result = await transactionalManager
        .createQueryBuilder()
        .update(TenantProvisioningKey)
        .set({ usedCount: () => '"used_count" + 1' })
        .where('id = :id AND ("max_devices" IS NULL OR "used_count" < "max_devices")', { id: keyId })
        .execute();

      if (result.affected === 0) {
        throw new ConflictException('Maximum device limit reached for this key');
      }
    } else {
      await transactionalManager
        .createQueryBuilder()
        .update(TenantProvisioningKey)
        .set({ usedCount: () => '"used_count" + 1' })
        .where('id = :id', { id: keyId })
        .execute();
    }
  }
}
