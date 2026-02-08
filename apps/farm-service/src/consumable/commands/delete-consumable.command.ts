export class DeleteConsumableCommand {
  constructor(
    public readonly consumableId: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
