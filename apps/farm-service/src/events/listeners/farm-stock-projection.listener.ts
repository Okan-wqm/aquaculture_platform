/**
 * FarmStockProjectionListener
 *
 * Event-driven maintainer of the farm-stock read model — the
 * `farm_stock_container_snapshots` / `farm_stock_batch_snapshots` tables the
 * mobile `farmStockInventory` query reads. Every stock-mutating farm command
 * already publishes a flat `@platform/event-contracts` domain event through the
 * transactional outbox; this listener subscribes to all of them and re-derives
 * the affected containers' snapshots via the SHARED
 * `FarmStockProjectionService.refreshContainers` — the exact same SSoT method
 * the write handlers call.
 *
 * WHY THIS EXISTS (mobile↔web drift, FARM-HIGH-103):
 *   The snapshot refresh used to be hand-enumerated inside each write handler
 *   (`refreshContainers(manager, tenantId, [tankId])` copy-pasted into ~10
 *   handlers). Any handler that forgot the call left the mobile read model
 *   stale — a freshly-stocked tank's fish (CreateBatchHandler.initialLocations),
 *   a feeding, or a cleaner-fish change never reached the app, so web showed the
 *   stock and mobile showed nothing. Making the projection event-driven removes
 *   that per-handler obligation entirely: because every stock mutation already
 *   emits a domain event, a new mutation path is covered automatically and no
 *   handler can silently forget. One mechanism, no duplicated call sites.
 *
 * TENANT ISOLATION:
 *   NATS handlers run OUTSIDE the HTTP request context (no AsyncLocalStorage
 *   tenant scope). `refreshContainers` is invoked inside
 *   `runInTenantTransaction(dataSource, 'farm', tenantId, ...)`, which pins
 *   `search_path` + the RLS GUC on a dedicated connection (fail-closed) —
 *   identical to how the write handlers scope the same call.
 *
 * DELIVERY SEMANTICS:
 *   A read-model projection must converge, so a transient refresh failure is
 *   RETHROWN to let the consumer redeliver (bounded by `max_deliver`) rather
 *   than silently dropping the update — this differs from the fire-and-forget
 *   alerting listeners (Mortality/Harvest), whose side effects are non-critical.
 *   `refreshContainers` is idempotent (it recomputes each snapshot from current
 *   state), so a redelivery is always safe.
 *
 * @module Events/Listeners
 */
import { isValidUUID, runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import type { BaseEvent } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';

/**
 * Every farm stock-mutation event whose commit changes a container's fish or
 * cleaner-fish occupancy, and therefore its read-model snapshot. Storage-domain
 * `StockMovementRecorded` (consumables/inventory, not tank stock) is excluded.
 */
const STOCK_MUTATION_EVENTS = [
  'BatchCreated',
  'BatchAllocatedToTank',
  'BatchTransferred',
  'MortalityRecorded',
  'CullRecorded',
  'CleanerFishMortalityRecorded',
  'FeedingRecorded',
] as const;

@Injectable()
export class FarmStockProjectionListener
  implements IEventHandler<BaseEvent>, OnModuleInit
{
  private readonly logger = new Logger(FarmStockProjectionListener.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly projectionService: FarmStockProjectionService,
    // EVENT_BUS is provided globally by EventBusModule (@Global). @Optional()
    // keeps the listener constructible in unit tests / NATS-less harnesses;
    // subscription is then skipped with a warning rather than crashing boot.
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: IEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      this.logger.warn(
        'EVENT_BUS not available — farm-stock projection subscription skipped. ' +
          'The mobile farmStockInventory read model will not auto-refresh.',
      );
      return;
    }
    // One listener, N explicit per-event subscriptions. subscribeWildcard builds
    // `events.*.{eventType}`, matching the producers' per-tenant
    // `events.{tenantId}.{eventType}` for every tenant (the read model is a
    // cross-tenant platform concern; per-event isolation is enforced in handle()).
    for (const eventType of STOCK_MUTATION_EVENTS) {
      await this.eventBus.subscribeWildcard(eventType, this);
    }
    this.logger.log(
      `Subscribed to ${STOCK_MUTATION_EVENTS.length} farm stock-mutation events ` +
        'for automatic read-model projection (cross-tenant wildcard)',
    );
  }

  getEventType(): string {
    // The listener fans out over STOCK_MUTATION_EVENTS via explicit
    // subscribeWildcard(name) calls (subscribeWildcard uses the passed name, not
    // this method); this representative label satisfies the IEventHandler contract.
    return 'FarmStockProjection';
  }

  /**
   * Refresh the read-model snapshots for the containers touched by one stock
   * event. Fail-closed on tenant identity; idempotent + retryable on the write.
   */
  async handle(event: BaseEvent): Promise<void> {
    if (!event.tenantId || !isValidUUID(event.tenantId)) {
      this.logger.error(
        'Farm stock event has missing/invalid tenantId — skipping to prevent ' +
          'cross-tenant read-model corruption.',
      );
      return;
    }

    const containerIds = FarmStockProjectionListener.extractContainerIds(event);
    if (containerIds.length === 0) {
      // Some events (e.g. a non-tank mortality) carry no tank reference; nothing
      // to project. Not an error.
      return;
    }

    try {
      await runInTenantTransaction(
        this.dataSource,
        'farm',
        event.tenantId,
        async (queryRunner) => {
          await this.projectionService.refreshContainers(
            queryRunner.manager,
            event.tenantId,
            containerIds,
          );
        },
      );
      this.logger.debug(
        `[${event.eventType}] refreshed ${containerIds.length} container ` +
          `snapshot(s) for tenant ${event.tenantId.substring(0, 8)}...`,
      );
    } catch (error) {
      this.logger.error(
        `[${event.eventType}] failed to refresh container snapshots for tenant ` +
          `${event.tenantId.substring(0, 8)}...: ${(error as Error).message}`,
        (error as Error).stack,
      );
      // Rethrow so the read model converges via redelivery (bounded by
      // max_deliver); refreshContainers is idempotent so the retry is safe.
      throw error;
    }
  }

  /**
   * Extract the affected container (tank) ids from any stock-mutation event.
   * Different contracts name the tank differently — `tankId`, `tankIds[]`
   * (BatchCreated initial stocking), or `sourceTankId`/`destinationTankId`
   * (BatchTransferred). Reads whichever fields are present without inventing
   * contract shape; `Partial` keeps every access typed and optional.
   */
  static extractContainerIds(event: BaseEvent): string[] {
    const e = event as BaseEvent &
      Partial<{
        tankId: string;
        tankIds: string[];
        sourceTankId: string;
        destinationTankId: string;
      }>;
    const ids: string[] = [];
    const push = (value: unknown): void => {
      if (typeof value === 'string' && value.length > 0) {
        ids.push(value);
      }
    };
    push(e.tankId);
    push(e.sourceTankId);
    push(e.destinationTankId);
    if (Array.isArray(e.tankIds)) {
      for (const id of e.tankIds) {
        push(id);
      }
    }
    return [...new Set(ids)];
  }
}
