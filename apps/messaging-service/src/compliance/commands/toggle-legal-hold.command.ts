import { ICommand } from '@nestjs/cqrs';

/**
 * Command to activate or release a legal hold on messaging data.
 *
 * @see ADR-012 Phase 3 (Legal Hold Support)
 */
export class ToggleLegalHoldCommand implements ICommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    /** When true: activate a new hold. When false: release the specified hold. */
    public readonly activate: boolean,
    /** Required when releasing. The ID of the hold to release. */
    public readonly holdId: string | null,
    /** Required when activating. Scope: null = entire tenant. */
    public readonly channelId: string | null,
    /** Required when activating. Reason for the hold. */
    public readonly reason: string | null,
  ) {}
}
