import { ICommand } from '@nestjs/cqrs';

/**
 * Command to activate or release a legal hold on messaging data.
 *
 * # Dual-approver protocol (LEGAL-MEDIUM-002 cure)
 *
 * Release path requires TWO distinct SUPER_ADMIN identities:
 *   - userId: the approver actually committing the release.
 *   - approverId: a SEPARATE SUPER_ADMIN that countersigned the request.
 * The handler enforces userId !== approverId. The DB has a CHECK
 * constraint that pins the same invariant at the schema level
 * (`chk_legal_hold_no_self_approval`).
 *
 * The MFA step-up portion of the spec is wired via auth-service
 * claims (the auth-security-expert follow-on); this command's
 * shape is forward-compatible — userId/approverId already carry
 * the two identities that auth must verify independently.
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
    /** Required when activating. Reason for the hold (≥ 50 chars per spec). */
    public readonly reason: string | null,
    /** Required when activating. UUID of the legal matter (GDPR proportionality). */
    public readonly legalMatterId: string | null = null,
    /** Optional description of the legal matter. */
    public readonly legalMatterDescription: string | null = null,
    /** Optional user/entity that requested the hold. */
    public readonly requestedBy: string | null = null,
    /** Optional expiration date for the hold. */
    public readonly expiresAt: Date | null = null,
    /**
     * Required when releasing. The SECOND SUPER_ADMIN's id (dual-approver
     * protocol). MUST be different from `userId`. Pre-cure single-identity
     * release was the LEGAL-MEDIUM-002 gap.
     */
    public readonly approverId: string | null = null,
    /**
     * Required when releasing. Free-text justification (≥ 50 chars per spec)
     * recorded for audit. Pre-cure release path captured no reason at all.
     */
    public readonly releaseReason: string | null = null,
  ) {}
}
