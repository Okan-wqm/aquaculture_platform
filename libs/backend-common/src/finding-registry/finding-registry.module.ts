import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FindingRegistryService } from './finding-registry.service';
import { FindingEntity } from './finding.entity';

/**
 * FindingRegistryModule — Phase 12.1 completion.
 *
 * Registers the FindingEntity with TypeORM and exports the
 * FindingRegistryService so cross-service consumers (orchestrator
 * runtime, finding-state-sweep, observability dashboards) can
 * append / query findings via the canonical service.
 *
 * # Who owns the PG schema
 *
 * `event_store.findings` belongs to event-store-service (the
 * migration lives in apps/event-store-service/src/migrations/).
 * Other services read + write via this module's service but do
 * not own the schema. If a consumer service connects to a
 * DataSource that does NOT have event-store-service's role grant
 * on event_store.findings, the service's append() will fail —
 * intentional belt-and-braces.
 *
 * # Usage
 *
 *   imports: [
 *     TypeOrmModule.forRootAsync({ ... }),
 *     FindingRegistryModule,
 *   ]
 *
 *   constructor(private readonly registry: FindingRegistryService) {}
 *
 *   await this.registry.append({ id: 'DATA-HIGH-001', ... });
 */
@Module({
  imports: [TypeOrmModule.forFeature([FindingEntity])],
  providers: [FindingRegistryService],
  exports: [FindingRegistryService],
})
export class FindingRegistryModule {}
