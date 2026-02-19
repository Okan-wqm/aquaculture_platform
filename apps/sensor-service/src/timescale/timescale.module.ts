import { Module } from '@nestjs/common';

import { ContinuousAggregateService } from './continuous-aggregate.service';
import { HypertableService } from './hypertable.service';
import { RetentionPolicyService } from './retention-policy.service';

/**
 * TimescaleDB Module
 *
 * Provides runtime management services for TimescaleDB hypertables,
 * continuous aggregates, and retention policies.
 *
 * Relies on TypeOrmModule (and its DataSource) being provided by AppModule.
 */
@Module({
  providers: [
    HypertableService,
    ContinuousAggregateService,
    RetentionPolicyService,
  ],
  exports: [
    HypertableService,
    ContinuousAggregateService,
    RetentionPolicyService,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class TimescaleModule {}
