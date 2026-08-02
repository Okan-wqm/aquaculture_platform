import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';

import {
  buildMetNorwayUserAgent,
  MET_NORWAY_ENV_KEYS,
  MetNorwayProvider,
  MetNorwayProviderConfig,
} from './met-norway-provider';

const DEFERRED_PROVIDER_CONFIG: MetNorwayProviderConfig = {
  applicationName: 'AquaSaaS/1.0',
  contact: 'https://aquaculture.invalid/environment-monitoring',
};

export enum EnvironmentProviderConfigurationCode {
  MET_APPLICATION_IDENTITY = 'MET_APPLICATION_IDENTITY',
  MET_FROST_CLIENT_ID = 'MET_FROST_CLIENT_ID',
}

export interface EnvironmentProviderConfigurationCheck {
  configured: boolean;
  errorCode: EnvironmentProviderConfigurationCode | null;
}

/**
 * Resolves provider configuration without making optional integrations a
 * process-startup dependency. The feature gate defaults to disabled, so Nest
 * must be able to construct the provider graph before deployment credentials
 * are present. Writers call `checkMetNorway` before every provider request and
 * record CONFIGURATION_ERROR instead of issuing a request with placeholder
 * identity.
 */
@Injectable()
export class EnvironmentProviderConfigurationService {
  constructor(private readonly configService: ConfigService) {}

  metNorwayProviderConfig(): MetNorwayProviderConfig {
    const candidate = this.readMetNorwayConfig();
    if (!this.hasValidMetIdentity(candidate)) {
      return DEFERRED_PROVIDER_CONFIG;
    }
    return candidate;
  }

  checkMetNorway(provider: MetNorwayProvider): EnvironmentProviderConfigurationCheck {
    const candidate = this.readMetNorwayConfig();
    if (!this.hasValidMetIdentity(candidate)) {
      return {
        configured: false,
        errorCode: EnvironmentProviderConfigurationCode.MET_APPLICATION_IDENTITY,
      };
    }
    if (
      provider === MetNorwayProvider.FROST &&
      (candidate.frostClientId === undefined || candidate.frostClientId.trim().length === 0)
    ) {
      return {
        configured: false,
        errorCode: EnvironmentProviderConfigurationCode.MET_FROST_CLIENT_ID,
      };
    }
    return { configured: true, errorCode: null };
  }

  private readMetNorwayConfig(): MetNorwayProviderConfig {
    const applicationName =
      this.configService.get<string>(MET_NORWAY_ENV_KEYS.applicationName) ?? '';
    const contact = this.configService.get<string>(MET_NORWAY_ENV_KEYS.contact) ?? '';
    const frostClientId = this.configService.get<string>(MET_NORWAY_ENV_KEYS.frostClientId);
    return { applicationName, contact, frostClientId };
  }

  private hasValidMetIdentity(config: MetNorwayProviderConfig): boolean {
    try {
      buildMetNorwayUserAgent(config, MetNorwayProvider.LOCATIONFORECAST);
      return true;
    } catch {
      return false;
    }
  }
}
