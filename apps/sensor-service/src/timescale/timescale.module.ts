import { Module } from '@nestjs/common';

import { ContinuousAggregateService } from './continuous-aggregate.service';
import { HypertableService } from './hypertable.service';
import { RetentionPolicyService } from './retention-policy.service';
import { TimeBucketService } from '../aggregation/time-bucket.service';

/**
 * TimescaleDB Module
 *
 * Provides runtime management services for TimescaleDB hypertables,
 * continuous aggregates, and retention policies.
 *
 * Relies on TypeOrmModule (and its DataSource) being provided by AppModule.
 *
 * NOTE: import TimescaleModule in app.module.ts when TimescaleDB
 * continuous-aggregate migrations are active (metrics_1min, metrics_1hour,
 * metrics_1day views must exist before TimeBucketService queries run).
 */
@Module({
  providers: [
    HypertableService,
    ContinuousAggregateService,
    RetentionPolicyService,
    TimeBucketService,
  ],
  exports: [
    HypertableService,
    ContinuousAggregateService,
    RetentionPolicyService,
    TimeBucketService,
  ],
})
 
export class TimescaleModule {}
