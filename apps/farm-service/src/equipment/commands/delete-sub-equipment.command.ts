/**
 * Delete SubEquipment Command
 */
export class DeleteSubEquipmentCommand {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
