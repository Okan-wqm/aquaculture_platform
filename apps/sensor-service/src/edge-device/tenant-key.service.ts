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
import { Repository, EntityManager } from 'typeorm';

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
  ) {}

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
    const key = await this.tenantKeyRepository.findOne({
      where: { keyToken: token },
    });

    if (!key) {
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
