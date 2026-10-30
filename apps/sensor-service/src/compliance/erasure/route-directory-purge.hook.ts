import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import type { TenantErasurePostErasureHook } from '@aquaculture/backend-common/compliance';
import {
  SENSOR_SOURCE_SCHEMA,
  SENSOR_TENANT_ROUTE_TABLES,
} from '@aquaculture/backend-common/database';
import type { TenantErasureRequestedEvent } from '@platform/event-contracts';

/**
 * Purge the erased tenant's rows from the cross-tenant route tables —
 * SENSOR_TENANT_ROUTE_TABLES, sensor-service's MODULE_SCHEMAS
 * `tenantRouteTables`: `sensor.edge_device_directory`,
 * `sensor.tenant_provisioning_key_directory` (SENSOR-HIGH-175) and
 * `sensor.sensor_mqtt_directory` (ADR-047). The db-migrate schema delete job
 * purges the same list when it drops a tenant's schema.
 *
 * WHY: sensor-service is a `tenant-schema-module` erasure target — the executor
 * empties the tenant's own schema and never touches source-schema tables. The
 * routes live once in `sensor`, so without this hook an erased tenant's device
 * identifiers, key routes and sensor broker usernames would outlive the
 * erasure. They resolve nothing afterwards (the tenant rows they point at are
 * gone), but a route is still data about the tenant. Runs in the erasure
 * transaction, after the sweep and before the proof, like
 * PublishedOutboxPurgeHook.
 */
@Injectable()
export class RouteDirectoryPurgeHook implements TenantErasurePostErasureHook {
  readonly hookName = 'sensor-route-directory-purge';

  async onTenantErased(
    event: TenantErasureRequestedEvent,
    manager: EntityManager,
  ): Promise<number> {
    if (event.dryRun) {
      return 0; // Dry-run must not mutate the routes.
    }
    let total = 0;
    for (const table of SENSOR_TENANT_ROUTE_TABLES) {
      const result: unknown = await manager.query(
        `DELETE FROM "${SENSOR_SOURCE_SCHEMA}"."${table}" WHERE "tenant_id" = $1`,
        [event.tenantId],
      );
      const deleted = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
      total += deleted;
      if (deleted > 0) {
        new Logger(RouteDirectoryPurgeHook.name).log(
          `Purged ${deleted} ${table} rows for erased tenant ${event.tenantId.slice(0, 8)}…`,
        );
      }
    }
    return total;
  }
}
