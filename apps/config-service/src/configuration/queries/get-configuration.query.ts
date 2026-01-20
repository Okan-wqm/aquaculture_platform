export class GetConfigurationQuery {
  constructor(
    public readonly tenantId: string,
    public readonly service: string,
    public readonly key: string,
    public readonly environment?: string,
  ) {}
}

export class GetConfigurationByIdQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
