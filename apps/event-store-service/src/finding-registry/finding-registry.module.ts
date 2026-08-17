import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FindingEventEntity } from './finding-event.entity';
import { FindingRegistryService } from './finding-registry.service';

/**
 * Database-facing finding ledger boundary owned by event-store-service.
 * Other bounded contexts consume an explicit event-store API; they never
 * import this persistence module or receive direct table access.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FindingEventEntity])],
  providers: [FindingRegistryService],
  exports: [FindingRegistryService],
})
export class FindingRegistryModule {}
