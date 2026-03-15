export class DeactivateWorkAreaCommand {
  constructor(
    public readonly tenantId: string,
    public readonly workAreaId: string,
    public readonly userId: string,
  ) {}
}
