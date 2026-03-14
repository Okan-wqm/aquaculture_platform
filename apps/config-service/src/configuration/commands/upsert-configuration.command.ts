import { ConfigEnvironment } from '../entities/configuration.entity';

export class UpsertConfigurationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly service: string,
    public readonly key: string,
    public readonly value: string,
    public readonly environment: ConfigEnvironment,
    public readonly userId: string,
    public readonly isSecret: boolean = false,
    public readonly reason?: string,
  ) {}
}
