import { Injectable, Logger } from '@nestjs/common';
import { SecurityEventService } from '@aquaculture/backend-common/security';

import type { TenantBoundaryViolation } from './tenant-boundary-violation';

/** What is known about one boundary violation. Ids only — never reply data. */
export interface TenantBoundaryViolationReport {
  readonly violation: TenantBoundaryViolation;
  /** The tenant the execution was bound to. */
  readonly expectedTenantId: string;
  /** The tenant a reply claimed to serve (reply mismatches only). */
  readonly servedTenantId: string | null;
  readonly correlationId: string;
}

/**
 * Writes the record of an AI tenant-boundary violation (K10 layer 3).
 *
 * WHAT: one structured error log plus one `TenantAccessDenied` security event
 * (observability-service consumes `events.security.events.>`).
 *
 * WHY no user id and no payload: the log/event must be safe to ship anywhere
 * (PII-masked by construction). The correlationId joins it to the
 * tool_execution_audit row, which already attributes the call to its user.
 */
@Injectable()
export class TenantBoundaryViolationReporter {
  private readonly logger = new Logger(TenantBoundaryViolationReporter.name);

  constructor(private readonly securityEvents: SecurityEventService) {}

  async report(entry: TenantBoundaryViolationReport): Promise<void> {
    const { violation, expectedTenantId, servedTenantId, correlationId } = entry;
    this.logger.error({
      msg: 'AI tenant-boundary violation — execution stopped, reply discarded',
      code: violation.code,
      reason: violation.reason,
      subject: violation.subject,
      expectedTenantId,
      servedTenantId,
      correlationId,
    });
    // Best-effort by contract: SecurityEventService never throws.
    await this.securityEvents.publishTenantAccessDenied({
      tenantId: expectedTenantId,
      correlationId,
      requestedTenantId: servedTenantId ?? 'none',
      reason: `ai_tool_${violation.reason}:${violation.subject}`,
    });
  }
}
