import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const ENVIRONMENT_MONITORING_ENABLED_KEY = 'FARM_ENVIRONMENT_MONITORING_ENABLED';

const ENVIRONMENT_MONITORING_DISABLED_RESPONSE = {
  statusCode: 503,
  code: 'ENVIRONMENT_MONITORING_DISABLED',
  message: 'Environmental monitoring is not enabled for this deployment',
} as const;

export interface EnvironmentMonitoringConfiguration {
  get(key: string): string | undefined;
}

/**
 * Canonical rollout gate for every environmental-monitoring entry point.
 *
 * Missing configuration is deliberately disabled. Unknown values fail during
 * dependency construction so a typo cannot produce a partially enabled system
 * in which readers, binary routes, and scheduled writers disagree.
 */
@Injectable()
export class EnvironmentMonitoringGate {
  private readonly enabled: boolean;

  constructor(
    @Inject(ConfigService)
    configService: EnvironmentMonitoringConfiguration,
  ) {
    this.enabled = parseEnvironmentMonitoringFlag(
      configService.get(ENVIRONMENT_MONITORING_ENABLED_KEY),
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException(ENVIRONMENT_MONITORING_DISABLED_RESPONSE);
    }
  }
}

export function parseEnvironmentMonitoringFlag(rawValue: string | undefined): boolean {
  if (rawValue === undefined) {
    return false;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new Error(`${ENVIRONMENT_MONITORING_ENABLED_KEY} must be either "true" or "false"`);
}
