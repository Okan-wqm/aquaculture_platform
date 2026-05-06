import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccessLogEntity } from './access-log.entity';

/**
 * DTO for creating an access log entry.
 *
 * # Why these fields and not the audit-log mandatory shape
 *
 * Access logs are request-level forensic primitives — method, path,
 * status, duration. They DO NOT carry actorHomeTenantId / mfaVerified
 * / preStateHash / etc. (the AUDITTRAIL-CRITICAL-004 mandatory shape)
 * because those concepts only make sense at the semantic-action
 * tier. See `access-log.entity.ts` class docstring for the
 * divergence-by-design rationale.
 */
export interface CreateAccessLogDto {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId?: string | null;
  tenantId?: string | null;
  correlationId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * AccessLogService — persistence boundary for the low-level HTTP
 * access stream (AUDITTRAIL-HIGH-004).
 *
 * # Why fire-and-forget is the correct posture here
 *
 * Unlike `AuditLogService.recordAwait` (which is fail-closed
 * because losing a semantic-action audit row breaks SOC 2 evidence
 * chains), access logs are observability rows. The auditor's
 * invariant explicitly admits the access stream as separate-and-
 * lower-priority (90d retention vs 7y). The trade-offs:
 *
 *   - Fail-closed access logging would convert every transient DB
 *     blip into a 5xx for every authenticated request. Access
 *     logging would become a denial-of-service vector against
 *     itself.
 *   - Loss of an individual access log row, in contrast, costs at
 *     most a single missing line in a 90-day forensics window —
 *     proportional risk for proportional cost.
 *
 * The failure counter (`getFailureCount`) plus the AUDIT_FAILURE
 * log line on every miss keeps operators aware of persistence-
 * health degradation without converting the symptom into an
 * outage.
 *
 * # Why @Optional() on the injected repo
 *
 * Same pattern as AuditLogService — services that don't import
 * AccessLogModule shouldn't fail boot. The service degrades to
 * a no-op + debug log so the module is opt-in per service rather
 * than a hard cross-cutting dependency.
 */
@Injectable()
export class AccessLogService {
  private readonly logger = new Logger(AccessLogService.name);

  /**
   * Monotonic counter of access-log persistence failures since
   * process start. Exposed via getFailureCount() so health-check
   * endpoints / Prometheus collectors can surface the rate
   * without scraping log lines.
   */
  private failureCount = 0;

  constructor(
    @Optional()
    @InjectRepository(AccessLogEntity)
    private readonly repo?: Repository<AccessLogEntity>,
  ) {}

  /**
   * Persist an access log row (fire-and-forget). See class
   * docstring for the deliberate fail-open posture.
   */
  record(dto: CreateAccessLogDto): void {
    if (!this.repo) {
      this.logger.debug(
        `Access log skipped (no repository): ${dto.method} ${dto.path}`,
      );
      return;
    }

    const entity = this.repo.create({
      method: dto.method,
      path: dto.path,
      status: dto.status,
      durationMs: dto.durationMs,
      userId: dto.userId ?? null,
      tenantId: dto.tenantId ?? null,
      correlationId: dto.correlationId ?? null,
      ip: dto.ip ?? null,
      userAgent: dto.userAgent ?? null,
    });

    this.repo.save(entity).catch((err: unknown) => {
      this.failureCount++;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `ACCESS_LOG_FAILURE [count=${this.failureCount}]: ${dto.method} ${dto.path} - ${message}`,
      );
    });
  }

  getFailureCount(): number {
    return this.failureCount;
  }
}
