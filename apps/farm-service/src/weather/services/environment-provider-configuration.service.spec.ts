import { ConfigService } from '@nestjs/config';

import {
  EnvironmentProviderConfigurationCode,
  EnvironmentProviderConfigurationService,
} from './environment-provider-configuration.service';
import { MetNorwayProvider } from './met-norway-provider';

function configuration(
  values: Readonly<Record<string, string>>,
): EnvironmentProviderConfigurationService {
  const configService: ConfigService = Object.create(ConfigService.prototype);
  configService.get = jest.fn((key: string) => values[key]);
  return new EnvironmentProviderConfigurationService(configService);
}

describe('EnvironmentProviderConfigurationService', () => {
  it('supplies a non-network placeholder graph when optional MET configuration is absent', () => {
    const service = configuration({});

    expect(service.metNorwayProviderConfig()).toEqual({
      applicationName: 'AquaSaaS/1.0',
      contact: 'https://aquaculture.invalid/environment-monitoring',
    });
    expect(service.checkMetNorway(MetNorwayProvider.LOCATIONFORECAST)).toEqual({
      configured: false,
      errorCode: EnvironmentProviderConfigurationCode.MET_APPLICATION_IDENTITY,
    });
  });

  it('requires Frost credentials independently from the shared MET identity', () => {
    const service = configuration({
      MET_NORWAY_APPLICATION_NAME: 'AquaSaaS/1.0',
      MET_NORWAY_CONTACT: 'support@example.test',
    });

    expect(service.checkMetNorway(MetNorwayProvider.LOCATIONFORECAST)).toEqual({
      configured: true,
      errorCode: null,
    });
    expect(service.checkMetNorway(MetNorwayProvider.FROST)).toEqual({
      configured: false,
      errorCode: EnvironmentProviderConfigurationCode.MET_FROST_CLIENT_ID,
    });
  });

  it('enables Frost only with the shared identity and its optional client ID', () => {
    const service = configuration({
      MET_NORWAY_APPLICATION_NAME: 'AquaSaaS/1.0',
      MET_NORWAY_CONTACT: 'support@example.test',
      MET_NORWAY_FROST_CLIENT_ID: 'public-data-client',
    });

    expect(service.checkMetNorway(MetNorwayProvider.FROST)).toEqual({
      configured: true,
      errorCode: null,
    });
  });
});
