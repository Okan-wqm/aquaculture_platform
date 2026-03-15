export class StartRotationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly rotationId: string,
    public readonly userId: string,
    public readonly actualStartDate?: string,
  ) {}
}
