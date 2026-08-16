import { ConfigurationKeyId, configurationDefinition } from '@aquaculture/configuration-contracts';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { runInRlsScopedSnapshotRead } from '../../database/rls-scoped-session';
import { SYSTEM_TENANT_ID } from '../configuration.constants';
import { ConfigEnvironment, Configuration } from '../entities/configuration.entity';

import { EncryptionService } from './encryption.service';

export interface EffectiveConfigurationV1 {
  value: string;
  sourceTenantId: string;
  configVersion: number;
}

/** Catalog-ID-only runtime read service. It owns no defaults and accepts no arbitrary keys. */
@Injectable()
export class ConfigurationService {
  private readonly logger = new Logger(ConfigurationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryptionService: EncryptionService,
  ) {}

  async getEffectiveWithMeta(
    tenantId: string,
    keyId: ConfigurationKeyId,
  ): Promise<EffectiveConfigurationV1 | null> {
    const configuration = await this.resolveActiveConfiguration(tenantId, keyId);
    if (!configuration) return null;
    const definition = configurationDefinition(keyId);
    let value = configuration.value;
    if (definition.valueType === 'SECRET') {
      if (
        !this.encryptionService.isAvailable() ||
        !this.encryptionService.isEncrypted(configuration.value)
      ) {
        throw new Error(`Secret configuration is unavailable: ${keyId}`);
      }
      try {
        value = this.encryptionService.decrypt(configuration.value, configuration.tenantId, keyId);
      } catch (error) {
        this.logger.error(`Failed to decrypt catalog configuration ${keyId}`);
        throw error;
      }
    }
    return {
      value,
      sourceTenantId: configuration.tenantId,
      configVersion: configuration.version,
    };
  }

  async getEffectiveWithMetaFresh(
    tenantId: string,
    keyId: ConfigurationKeyId,
  ): Promise<EffectiveConfigurationV1 | null> {
    return this.getEffectiveWithMeta(tenantId, keyId);
  }

  private async resolveActiveConfiguration(
    tenantId: string,
    keyId: ConfigurationKeyId,
  ): Promise<Configuration | null> {
    return runInRlsScopedSnapshotRead(this.dataSource, tenantId, async (manager, pinScope) => {
      const tenantConfiguration = await tenantManagerRepo(manager, Configuration, tenantId).findOne(
        {
          where: { tenantId, catalogId: keyId, environment: ConfigEnvironment.ALL },
        },
      );
      if (tenantConfiguration?.isActive) return tenantConfiguration;
      if (tenantConfiguration?.suppressFallback) return null;
      if (tenantId === SYSTEM_TENANT_ID) return null;
      await pinScope(SYSTEM_TENANT_ID);
      return tenantManagerRepo(manager, Configuration, SYSTEM_TENANT_ID).findOne({
        where: {
          tenantId: SYSTEM_TENANT_ID,
          catalogId: keyId,
          environment: ConfigEnvironment.ALL,
          isActive: true,
        },
      });
    });
  }
}
