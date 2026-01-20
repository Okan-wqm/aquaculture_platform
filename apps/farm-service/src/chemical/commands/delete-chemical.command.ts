/**
 * Delete Chemical Command
 */
export class DeleteChemicalCommand {
  constructor(
    public readonly chemicalId: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
