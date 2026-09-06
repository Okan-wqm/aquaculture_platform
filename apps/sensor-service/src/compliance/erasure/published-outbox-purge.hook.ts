import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import type { TenantErasurePostErasureHook } from '@aquaculture/backend-common/compliance';
import type { TenantErasureRequestedEvent } from '@platform/event-contracts';

/**
 * Task 1.8 (100-tenant readiness plan): purge the tenant's PUBLISHED
 * outbox rows as a post-erasure hook.
 *
 * WHY the executor's structural exclusion is not enough: the outbox is
 * excluded from the row-delete sweep so PENDING rows (including this very
 * erasure's own proof event) survive to publication — but the 7-day
 * cleanup is the ONLY thing that removes PUBLISHED rows, so a freshly
 * erased tenant's telemetry payloads sit in `sensor.sensor_outbox` for up
 * to a week after the erasure proof is written. GDPR Art. 17 erasure must
 * not leave a copy of the erased data in a side table.
 *
 * Ordering makes this safe: the hook runs in the SAME transaction, AFTER
 * the table sweep and BEFORE the proof enqueue. Pending rows for this
 * tenant cannot exist at that point (they would have been published or
 * are part of this transaction's own enqueue which happens later), so
 * deleting WHERE published_at IS NOT NULL only touches rows the broker
 * already has — the audit trail for the erasure itself lives in the
 * proof ledger, not the outbox.
 */
const OUTBOX_SCHEMA = 'sensor';
const OUTBOX_TABLE = 'sensor_outbox';

@Injectable()
export class PublishedOutboxPurgeHook implements TenantErasurePostErasureHook {
  readonly hookName = 'sensor-published-outbox-purge';

  async onTenantErased(event: TenantErasureRequestedEvent, manager: EntityManager): Promise<void> {
    if (event.dryRun) {
      return; // Dry-run must not mutate the outbox.
    }
    const result = await manager.query(
      `DELETE FROM "${OUTBOX_SCHEMA}"."${OUTBOX_TABLE}"
        WHERE "tenantId" = $1 AND "publishedAt" IS NOT NULL`,
      [event.tenantId],
    );
    const deleted = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
    if (deleted > 0) {
      new Logger(PublishedOutboxPurgeHook.name).log(
        `Purged ${deleted} published outbox rows for erased tenant ${event.tenantId.slice(0, 8)}…`,
      );
    }
  }
}
