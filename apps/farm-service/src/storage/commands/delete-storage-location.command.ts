export class DeleteStorageLocationCommand {
  constructor(
    public readonly locationId: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
