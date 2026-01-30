/**
 * DeleteHarvestRecordCommand
 *
 * Command for deleting (soft delete) a harvest record.
 *
 * @module Harvest/Commands
 */

export class DeleteHarvestRecordCommand {
  constructor(
    public readonly tenantId: string,
    public readonly harvestRecordId: string,
    public readonly deletedBy: string,
  ) {}
}
