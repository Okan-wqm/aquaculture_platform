export class EndRotationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly rotationId: string,
    public readonly userId: string,
    public readonly actualEndDate?: string,
    public readonly notes?: string,
  ) {}
}
