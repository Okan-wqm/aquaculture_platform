import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

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
 * On bootstrap, ContinuousAggregateService creates the sensor.metrics_1min/
 * 1hour/1day continuous aggregates (SENSOR-MEDIUM-066/068, OPEN-ADR-030-CAGG) —
 * the rollup views MetricQueryService + TimeBucketService read from. This is
 * why the module must be imported in app.module.ts (it now is).
 */
@Module({
  imports: [ConfigModule],
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
