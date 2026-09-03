import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { IEventBus } from '@platform/event-bus';

/**
 * Task 1.8 (100-tenant readiness plan): the erased-tenant tombstone set.
 *
 * Ingress must never recreate erased tenants' data: a late MQTT message
 * from a still-connected device (its credential may live up to the auth
 * cache TTL) would otherwise re-insert rows into the freshly dropped
 * schema and enqueue a fresh outbox row — the erasure becomes Swiss
 * cheese. This service keeps a process-local set of erased tenant UUIDs,
 * fed from the platform `TenantErased` event, and answers the one
 * question ingress asks: `isErased(tenantId)`.
 *
 * Persistence honesty: the set is a CACHE, not the record — the
 * authoritative state is the platform tenant registry, and a restarted
 * replica rebuilds by re-reading `auth.tenants` rows whose status marks
 * them erased (the same SSoT the provisioning workflow writes). The
 * TombstoneSyncOnBoot spec pins that rebuild.
 */
@Injectable()
export class ErasedTenantTombstoneService implements OnModuleInit {
  private readonly logger = new Logger(ErasedTenantTombstoneService.name);
  private readonly erased = new Set<string>();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** Rebuild from the authoritative registry at boot. */
  async onModuleInit(): Promise<void> {
    try {
      const rows: Array<{ tenant_id: string }> = await this.dataSource.query(
        `SELECT id::text AS tenant_id FROM auth.tenants WHERE status = 'ERASED'`,
      );
      for (const row of rows) {
        this.erased.add(row.tenant_id);
      }
      if (rows.length > 0) {
        this.logger.log(`Tombstone set rebuilt: ${rows.length} erased tenant(s)`);
      }
    } catch (error) {
      // Fail-open with a loud log: the tombstone is a cache over the
      // registry, and blocking service boot on the auth schema would trade
      // availability for a staleness window the TTL of the auth cache
      // already bounds.
      this.logger.warn(
        `Tombstone rebuild query failed (isErased will answer false until the first TenantErased event): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Record a tenant as erased (idempotent). */
  markErased(tenantId: string): void {
    this.erased.add(tenantId);
  }

  /** The ingress gate: true → ACK-drop, never write. */
  isErased(tenantId: string): boolean {
    return this.erased.has(tenantId);
  }

  /** Subscribe to the platform erasure event (wired by the module). */
  attachEventBus(eventBus: IEventBus): void {
    void eventBus
      .subscribeTo('events.*.TenantErased', {
        handle: (event: Record<string, unknown>) => {
          if (event['eventType'] === 'TenantErased' && typeof event['tenantId'] === 'string') {
            this.markErased(event['tenantId']);
            this.logger.warn(
              `Tenant ${event['tenantId'].slice(0, 8)}… erased — ingress will ACK-drop its messages`,
            );
          }
          return Promise.resolve();
        },
      } as never)
      .catch((error: unknown) => {
        this.logger.error(
          `Failed to subscribe TenantErased: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
