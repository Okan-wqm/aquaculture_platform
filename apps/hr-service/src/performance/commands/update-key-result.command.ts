export class UpdateKeyResultCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly goalId: string,
    public readonly keyResultId: string,
    public readonly currentValue: number,
  ) {}
}
