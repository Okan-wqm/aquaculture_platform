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
    /** Required when activating. UUID of the legal matter (GDPR proportionality). */
    public readonly legalMatterId: string | null = null,
    /** Optional description of the legal matter. */
    public readonly legalMatterDescription: string | null = null,
    /** Optional user/entity that requested the hold. */
    public readonly requestedBy: string | null = null,
    /** Optional expiration date for the hold. */
    public readonly expiresAt: Date | null = null,
  ) {}
}
