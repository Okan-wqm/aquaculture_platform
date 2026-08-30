import { OUTBOX_UUID_REGEX } from './constants';
import { OUTBOX_ROUTING_SCOPE_FIELD, OUTBOX_SYSTEM_TENANT_ID } from './outbox-routing';

/**
 * Raised at the outbox WORKER dispatch boundary when a leased row's tenant of
 * record cannot be trusted (FARM-HIGH-083). Carries the column + payload tenant
 * so operators can triage the dead-lettered row. It is a PERMANENT failure —
 * retrying re-reads the same mismatched payload — so the worker dead-letters the
 * row immediately rather than burning the retry budget.
 */
export class OutboxTenantIntegrityError extends Error {
  constructor(
    public readonly rowId: string,
    public readonly columnTenantId: string | null,
    public readonly payloadTenantId: string | null,
  ) {
    super(
      `Outbox row ${rowId} failed tenant-integrity (column=${columnTenantId ?? 'null'}, ` +
        `payload=${payloadTenantId ?? 'null'}): a tenant-scoped row whose tenant of record is ` +
        `missing, non-UUID, or mismatched is dead-lettered, never published — publishing it would ` +
        `let IEventBus.deriveSubject() silently downgrade it onto the cross-tenant events.system.* subject.`,
    );
    this.name = 'OutboxTenantIntegrityError';
  }
}

interface TenantBearingRow {
  readonly id: string;
  readonly tenantId: string | null;
  readonly payload: unknown;
}

/**
 * WHY: the outbox worker drains rows across ALL tenants and derives the NATS
 * subject from the event's tenantId. `IEventBus.deriveSubject()` downgrades a
 * tenant-less event onto `events.system.*`, so a tenant-scoped row that reaches
 * dispatch without a valid tenant would be mis-routed to a cross-tenant subject —
 * a tenant-isolation breach the worker previously failed OPEN on.
 *
 * WHAT: assert the tenant of record before publishing. The fail-closed `tenantId`
 * column is authoritative (OutboxPublisher.enqueue rejects a non-UUID tenantId, so
 * a populated column is always a valid UUID); legacy rows written before the column
 * existed fall back to the payload tenantId. The effective tenant MUST be a valid
 * UUID, and a populated column MUST agree with the payload — otherwise throw, which
 * the worker turns into an immediate dead-letter. A genuinely tenant-less event
 * cannot exist on this path (the publisher requires a UUID), so there is no
 * legitimate `events.system.*` outbox emission to preserve.
 *
 * Tier-1 (make-it-impossible): no row can be published without passing this seam.
 */
export function assertOutboxTenantIntegrity(row: TenantBearingRow): void {
  const columnTenant = row.tenantId ?? null;
  const payload = row.payload as {
    tenantId?: string | null;
    [OUTBOX_ROUTING_SCOPE_FIELD]?: unknown;
  } | null;
  const payloadTenant = payload?.tenantId ?? null;
  const routingScope = payload?.[OUTBOX_ROUTING_SCOPE_FIELD];

  if (
    columnTenant === null &&
    payloadTenant === OUTBOX_SYSTEM_TENANT_ID &&
    routingScope === OUTBOX_SYSTEM_TENANT_ID
  ) {
    return;
  }

  if (routingScope !== undefined) {
    throw new OutboxTenantIntegrityError(row.id, columnTenant, payloadTenant);
  }

  const effective = columnTenant ?? payloadTenant;

  if (!effective || !OUTBOX_UUID_REGEX.test(effective)) {
    throw new OutboxTenantIntegrityError(row.id, columnTenant, payloadTenant);
  }
  if (columnTenant && payloadTenant !== columnTenant) {
    throw new OutboxTenantIntegrityError(row.id, columnTenant, payloadTenant);
  }
}
