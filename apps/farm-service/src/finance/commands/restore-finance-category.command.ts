export class RestoreFinanceCategoryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly categoryId: string,
    public readonly userId: string,
  ) {}
}
