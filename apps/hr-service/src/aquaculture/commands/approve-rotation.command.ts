export class ApproveRotationCommand {
  constructor(
    public readonly tenantId: string,
    public readonly rotationId: string,
    public readonly userId: string,
    public readonly notes?: string,
  ) {}
}
