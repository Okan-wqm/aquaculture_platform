import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

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
 *
 * On bootstrap, ContinuousAggregateService creates the sensor.metrics_1min/
 * 1hour/1day continuous aggregates (SENSOR-MEDIUM-066/068, OPEN-ADR-030-CAGG) —
 * the rollup views SensorQueryService and ChannelReadingQueryService read
 * through the shared tier selection in sensor/services/metric-source.ts. This is
 * why the module must be imported in app.module.ts (it now is).
 */
@Module({
  imports: [ConfigModule],
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
 
export class TimescaleModule {}
