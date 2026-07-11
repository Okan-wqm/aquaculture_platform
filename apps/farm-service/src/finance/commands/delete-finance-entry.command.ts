export class DeleteFinanceEntryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly entryId: string,
    public readonly userId: string,
  ) {}
}
