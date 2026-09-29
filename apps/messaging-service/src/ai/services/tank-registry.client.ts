/**
 * @module TankRegistryClient
 * @description The knowledge pipeline's tenant-bound read of a tenant's tank
 * registry from farm-service (`request.farm.getTankRegistry`, K10 / PR-T1,
 * MT-HIGH-062).
 *
 * WHY a dedicated client instead of an inline `natsClient.send`: the registry
 * decides which tank ids are written into THIS tenant's entity references and
 * knowledge entries. The reply therefore goes through the one consumer check
 * (`verifyTenantBoundReply`) BEFORE any row is looked at, and a reply served
 * for another tenant is recorded the same way ai-service records one: a
 * PII-free error log plus a `TenantAccessDenied` security event.
 *
 * WHAT it never does: throw. The hourly sweep degrades to "no registry" (no
 * tank links for this tenant this hour) on every failure, so one tenant's
 * farm-side trouble cannot stop another tenant's batch.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { SecurityEventService, tenantFingerprint } from '@aquaculture/backend-common/security';
import { verifyTenantBoundReply } from '@platform/event-contracts';
import { catchError, firstValueFrom, of, timeout } from 'rxjs';

/** NATS request timeout in milliseconds (30 seconds). */
const NATS_TIMEOUT_MS = 30_000;

export const TANK_REGISTRY_SUBJECT = 'request.farm.getTankRegistry';

/** Tank registry entry from farm-service (the fields this pipeline reads). */
export interface TankRegistryEntry {
  id: string;
  code: string;
  name: string;
}

/** Contract guard for the registry rows this pipeline reads (farm may send more fields). */
function isTankRegistry(value: unknown): value is TankRegistryEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row: unknown) =>
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        typeof row.id === 'string' &&
        'code' in row &&
        typeof row.code === 'string' &&
        'name' in row &&
        typeof row.name === 'string',
    )
  );
}

@Injectable()
export class TankRegistryClient {
  private readonly logger = new Logger(TankRegistryClient.name);

  constructor(
    @Inject('NATS_SERVICE') private readonly natsClient: ClientProxy,
    private readonly securityEvents: SecurityEventService,
  ) {}

  /**
   * The tenant's tank registry, or an empty list when it cannot be trusted.
   *
   * @param tenantId - Authoritative tenant UUID from the schema-mapping ledger
   *   (ORPHAN-MEDIUM-336) — never from message content.
   *
   * INVARIANT: rows are returned only when the reply names `tenantId`; if
   * violated → another tenant's tank ids are planted in this tenant's knowledge.
   */
  async fetch(tenantId: string): Promise<TankRegistryEntry[]> {
    const reply = await firstValueFrom(
      this.natsClient.send<unknown>(TANK_REGISTRY_SUBJECT, { tenantId }).pipe(
        timeout(NATS_TIMEOUT_MS),
        catchError((err: unknown) => {
          this.logger.warn({
            msg: 'tank registry request failed',
            subject: TANK_REGISTRY_SUBJECT,
            tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
          return of(null);
        }),
      ),
    );
    if (reply === null) return [];

    const verdict = verifyTenantBoundReply(reply, tenantId, isTankRegistry);
    switch (verdict.kind) {
      case 'data':
        return verdict.data;
      case 'tenant_mismatch':
        await this.reportMismatch(tenantId, verdict.servedTenantId);
        return [];
      case 'error':
        this.logger.warn({
          msg: 'tank registry unavailable',
          subject: TANK_REGISTRY_SUBJECT,
          tenantId,
          error: verdict.error,
        });
        return [];
      case 'malformed':
        this.logger.warn({
          msg: 'tank registry reply malformed',
          subject: TANK_REGISTRY_SUBJECT,
          tenantId,
          reason: verdict.reason,
        });
        if (verdict.reason === 'envelope') {
          // A reply that names no tenant cannot prove whose tanks it lists — recorded like a mismatch.
          await this.securityEvents.publishTenantAccessDenied({
            tenantId,
            requestedTenantId: 'none',
            reason: `knowledge_extraction_reply_without_tenant:${TANK_REGISTRY_SUBJECT}`,
          });
        }
        return [];
    }
  }

  /** Ids only — never the reply's rows. SecurityEventService never throws (best-effort by contract). */
  private async reportMismatch(tenantId: string, servedTenantId: string | null): Promise<void> {
    this.logger.error({
      msg: 'tenant_mismatch: tank registry reply served for another tenant was discarded',
      code: 'tenant_mismatch',
      subject: TANK_REGISTRY_SUBJECT,
      expectedTenantId: tenantId,
      servedTenantId,
    });
    await this.securityEvents.publishTenantAccessDenied({
      tenantId,
      // The event is this tenant's; the other tenant appears only as a fingerprint (V-T1a-10).
      requestedTenantId: servedTenantId === null ? 'none' : tenantFingerprint(servedTenantId),
      reason: `knowledge_extraction_reply_tenant_mismatch:${TANK_REGISTRY_SUBJECT}`,
    });
  }
}
