/**
 * Delete Feed Command
 */
export class DeleteFeedCommand {
  constructor(
    public readonly feedId: string,
    public readonly tenantId: string,
    public readonly userId: string,
  ) {}
}
