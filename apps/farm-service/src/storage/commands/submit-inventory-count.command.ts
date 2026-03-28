export class SubmitInventoryCountCommand {
  constructor(
    public readonly countId: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
