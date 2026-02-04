/**
 * Delete Feeding Protocol Command
 */
export class DeleteFeedingProtocolCommand {
  constructor(
    public readonly id: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
