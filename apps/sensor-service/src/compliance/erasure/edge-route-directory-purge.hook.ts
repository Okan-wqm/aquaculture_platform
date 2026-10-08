import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import type { TenantErasurePostErasureHook } from '@aquaculture/backend-common/compliance';
import type { TenantErasureRequestedEvent } from '@platform/event-contracts';

/**
 * Purge the erased tenant's rows from the two cross-tenant route tables,
 * `sensor.edge_device_directory` and `sensor.tenant_provisioning_key_directory`
 * (SENSOR-HIGH-175).
 *
 * WHY: sensor-service is a `tenant-schema-module` erasure target — the executor
 * empties the tenant's own schema and never touches source-schema tables. The
 * routes live once in `sensor`, so without this hook an erased tenant's device
 * identifiers and key routes would outlive the erasure. They resolve nothing
 * afterwards (the tenant rows they point at are gone), but a route is still
 * data about the tenant. Runs in the erasure transaction, after the sweep and
 * before the proof, like PublishedOutboxPurgeHook.
 */
const ROUTE_TABLES = ['edge_device_directory', 'tenant_provisioning_key_directory'] as const;

@Injectable()
export class EdgeRouteDirectoryPurgeHook implements TenantErasurePostErasureHook {
  readonly hookName = 'sensor-edge-route-directory-purge';

  async onTenantErased(
    event: TenantErasureRequestedEvent,
    manager: EntityManager,
  ): Promise<number> {
    if (event.dryRun) {
      return 0; // Dry-run must not mutate the routes.
    }
    let total = 0;
    for (const table of ROUTE_TABLES) {
      const result: unknown = await manager.query(
        `DELETE FROM "sensor"."${table}" WHERE "tenant_id" = $1`,
        [event.tenantId],
      );
      const deleted = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
      total += deleted;
      if (deleted > 0) {
        new Logger(EdgeRouteDirectoryPurgeHook.name).log(
          `Purged ${deleted} ${table} rows for erased tenant ${event.tenantId.slice(0, 8)}…`,
        );
      }
    }
    return total;
  }
}
