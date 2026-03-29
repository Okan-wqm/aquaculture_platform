import { ICommand } from '@nestjs/cqrs';

/**
 * Command to create or update a retention policy for a tenant or channel.
 *
 * @see ADR-012 Phase 3 (Retention Policies)
 */
export class SetRetentionPolicyCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly channelId: string | null,
    public readonly retentionDays: number,
  ) {}
}
