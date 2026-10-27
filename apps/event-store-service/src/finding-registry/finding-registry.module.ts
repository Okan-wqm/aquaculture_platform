import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FindingEventEntity } from './finding-event.entity';

/**
 * The finding event mirror's persistence boundary, owned by
 * event-store-service. The service only maps the table (schema drift is
 * judged against this entity); it writes nothing: the one writer is the
 * git-to-Postgres mirror, tools/gates/finding-event-ledger.ts. Other bounded
 * contexts never import this module or receive direct table access.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FindingEventEntity])],
})
export class FindingRegistryModule {}
