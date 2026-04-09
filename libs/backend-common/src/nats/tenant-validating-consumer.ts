/**
 * @module TenantValidatingConsumer
 * @description Base class for NATS consumers that enforces tenant isolation
 * by cross-checking the tenantId in the event payload against the NATS subject.
 *
 * SECURITY: Prevents cross-tenant data routing where a mismatched tenantId
 * in the payload could cause events to be processed in the wrong tenant context.
 *
 * All NATS consumers that process tenant-scoped events MUST extend this class
 * or call `validateTenantId()` before processing.
 *
 * Subject format: `events.{tenantId}.{eventType}` or `events.{eventType}`
 * (legacy format without tenantId segment).
 *
 * @see DATA-HIGH-016 (NATS consumer tenantId validation)
 */
import { Logger } from '@nestjs/common';

/**
 * Minimal event shape required for tenant validation.
 * Any event extending BaseEvent satisfies this.
 */
interface TenantScopedEvent {
  tenantId: string;
  eventType?: string;
}

/**
 * Result of tenant validation check.
 */
export interface TenantValidationResult {
  /** Whether the event passed tenant validation. */
  valid: boolean;
  /** Human-readable reason if invalid. */
  reason?: string;
  /** The tenantId extracted from the payload. */
  payloadTenantId: string;
  /** The tenantId extracted from the NATS subject (if present). */
  subjectTenantId?: string;
}

/**
 * Abstract base class for NATS consumers that require tenant isolation.
 *
 * Usage:
 * ```ts
 * @Controller()
 * export class MyEventHandler extends TenantValidatingConsumer {
 *   @EventPattern('events.*.MyEventType')
 *   async handleEvent(@Payload() data: MyEvent, @Ctx() ctx: NatsContext): Promise<void> {
 *     const validation = this.validateTenantFromSubject(data, ctx.getSubject());
 *     if (!validation.valid) return; // logged + rejected
 *     // ... process event with data.tenantId
 *   }
 * }
 * ```
 */
export abstract class TenantValidatingConsumer {
  protected readonly tenantLogger = new Logger(TenantValidatingConsumer.name);

  /**
   * Validate that the event payload tenantId matches the NATS subject tenant segment.
   *
   * Subject format: `events.{tenantId}.{eventType}` (3+ segments)
   * Legacy format: `events.{eventType}` (2 segments, no tenant in subject)
   *
   * For legacy subjects (no tenant segment), validation passes if payload has a tenantId.
   * For new-format subjects, payload.tenantId MUST match the subject tenant segment.
   *
   * @param event - The event payload (must have tenantId)
   * @param subject - The NATS subject string
   * @returns TenantValidationResult
   */
  protected validateTenantFromSubject(
    event: TenantScopedEvent,
    subject: string,
  ): TenantValidationResult {
    // ── Guard: event must have tenantId ──
    if (!event.tenantId) {
      const reason = `SECURITY: Event on subject "${subject}" has no tenantId in payload. Rejecting.`;
      this.tenantLogger.error(reason);
      return { valid: false, reason, payloadTenantId: '' };
    }

    // ── Parse subject segments ──
    const segments = subject.split('.');

    // Legacy format: events.{eventType} (2 segments) — no tenant in subject
    if (segments.length < 3) {
      return { valid: true, payloadTenantId: event.tenantId };
    }

    // New format: events.{tenantId}.{eventType} (3+ segments)
    // segments[0] = 'events', segments[1] = tenantId, segments[2+] = eventType
    const subjectTenantId = segments[1];

    if (!subjectTenantId) {
      return { valid: true, payloadTenantId: event.tenantId };
    }

    // Wildcard tenant segment (e.g., events.*.MyEvent) — skip validation
    if (subjectTenantId === '*' || subjectTenantId === '>') {
      return { valid: true, payloadTenantId: event.tenantId, subjectTenantId };
    }

    // ── Cross-check: payload tenantId MUST match subject tenantId ──
    if (event.tenantId !== subjectTenantId) {
      const reason =
        `SECURITY: Tenant ID mismatch — payload.tenantId="${event.tenantId}" ` +
        `does not match subject tenant segment="${subjectTenantId}" ` +
        `on subject "${subject}". Rejecting event to prevent cross-tenant routing.`;
      this.tenantLogger.error(reason);
      return {
        valid: false,
        reason,
        payloadTenantId: event.tenantId,
        subjectTenantId,
      };
    }

    return {
      valid: true,
      payloadTenantId: event.tenantId,
      subjectTenantId,
    };
  }

  /**
   * Extract the tenant ID from a NATS subject.
   * Returns undefined if the subject does not contain a tenant segment.
   *
   * @param subject - NATS subject string
   * @returns Tenant ID or undefined
   */
  protected extractTenantFromSubject(subject: string): string | undefined {
    const segments = subject.split('.');
    if (segments.length >= 3 && segments[1] !== '*' && segments[1] !== '>') {
      return segments[1];
    }
    return undefined;
  }
}
