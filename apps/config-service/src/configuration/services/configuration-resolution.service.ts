import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { GLOBAL_TENANT_UUID } from '@aquaculture/backend-common/tenant';
import {
  Configuration,
  ConfigEnvironment,
} from '../entities/configuration.entity';

function uniqueResolutionCandidates(
  tenantId: string,
  environment: ConfigEnvironment,
): Array<{ tenantId: string; environment: ConfigEnvironment }> {
  const candidates: Array<{ tenantId: string; environment: ConfigEnvironment }> = [
    { tenantId, environment },
  ];

  if (environment !== ConfigEnvironment.ALL) {
    candidates.push({ tenantId, environment: ConfigEnvironment.ALL });
  }

  if (tenantId !== GLOBAL_TENANT_UUID) {
    candidates.push({ tenantId: GLOBAL_TENANT_UUID, environment });
    if (environment !== ConfigEnvironment.ALL) {
      candidates.push({
        tenantId: GLOBAL_TENANT_UUID,
        environment: ConfigEnvironment.ALL,
      });
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.tenantId}:${candidate.environment}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

@Injectable()
export class ConfigurationResolutionService {
  constructor(
    @InjectRepository(Configuration)
    private readonly configRepository: Repository<Configuration>,
  ) {}

  async resolveConfiguration(
    tenantId: string,
    service: string,
    key: string,
    environment: ConfigEnvironment = ConfigEnvironment.ALL,
  ): Promise<Configuration | null> {
    const resolutionOrder = uniqueResolutionCandidates(tenantId, environment);
    const whereConditions: FindOptionsWhere<Configuration>[] = resolutionOrder.map(
      (candidate) => ({
        tenantId: candidate.tenantId,
        service,
        key,
        environment: candidate.environment,
        isActive: true,
      }),
    );

    const configs = await this.configRepository.find({
      where: whereConditions,
      take: resolutionOrder.length,
    });

    return resolutionOrder
      .map((candidate) =>
        configs.find(
          (candidateConfig) =>
            candidateConfig.tenantId === candidate.tenantId &&
            candidateConfig.environment === candidate.environment,
        ),
      )
      .find((candidateConfig): candidateConfig is Configuration => !!candidateConfig) ?? null;
  }

  async resolveConfigurationsByService(
    tenantId: string,
    service: string,
    environment: ConfigEnvironment = ConfigEnvironment.ALL,
  ): Promise<Configuration[]> {
    const resolutionOrder = uniqueResolutionCandidates(tenantId, environment);
    const whereConditions: FindOptionsWhere<Configuration>[] = resolutionOrder.map(
      (candidate) => ({
        tenantId: candidate.tenantId,
        service,
        environment: candidate.environment,
        isActive: true,
      }),
    );

    const configurations = await this.configRepository.find({
      where: whereConditions,
      order: { key: 'ASC' },
      take: 500,
    });

    const byKey = new Map<string, Configuration>();
    for (const candidate of resolutionOrder) {
      for (const config of configurations) {
        if (
          config.tenantId === candidate.tenantId &&
          config.environment === candidate.environment &&
          !byKey.has(config.key)
        ) {
          byKey.set(config.key, config);
        }
      }
    }

    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}
