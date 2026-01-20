import { ConfigurationFilterInput } from '../dto/create-configuration.input';

export class GetConfigurationsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: ConfigurationFilterInput,
  ) {}
}

export class GetConfigurationsByServiceQuery {
  constructor(
    public readonly tenantId: string,
    public readonly service: string,
    public readonly environment?: string,
  ) {}
}

export class GetConfigurationHistoryQuery {
  constructor(
    public readonly tenantId: string,
    public readonly configurationId: string,
    public readonly limit?: number,
  ) {}
}
