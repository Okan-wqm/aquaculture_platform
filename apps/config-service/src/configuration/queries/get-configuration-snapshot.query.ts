import { ConfigEnvironment } from '../entities/configuration.entity';

export class GetConfigurationSnapshotQuery {
  constructor(
    readonly tenantId: string,
    readonly environment: ConfigEnvironment,
  ) {}
}
