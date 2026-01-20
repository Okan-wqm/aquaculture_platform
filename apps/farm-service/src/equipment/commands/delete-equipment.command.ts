/**
 * Delete Equipment Command
 */
export class DeleteEquipmentCommand {
  constructor(
    public readonly equipmentId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly cascade: boolean = false,
  ) {}
}
