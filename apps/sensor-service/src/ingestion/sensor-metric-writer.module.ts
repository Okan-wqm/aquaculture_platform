import { Module } from '@nestjs/common';

import { SensorMetricWriterService } from './sensor-metric-writer.service';

/**
 * SENSOR-MEDIUM-068: the single home of the one writer for
 * `sensor.sensor_metrics`. Both ingestion planes import THIS module —
 * IngestionModule (MQTT, edge/IO, Rust-sidecar consumer) and SensorModule
 * (the GraphQL `SensorIngestionService`) — so the process holds exactly one
 * `SensorMetricWriterService`: one INSERT contract, one buffer, one flush
 * timer. Making the writer a shared module (rather than a provider each module
 * re-declares) is what keeps "one writer" true across module boundaries — two
 * separate `providers: [SensorMetricWriterService]` entries would mint two
 * buffers and split the store's write path again, defeating the convergence.
 *
 * The service depends only on the globally-provided DataSource, so this module
 * needs no imports of its own.
 */
@Module({
  providers: [SensorMetricWriterService],
  exports: [SensorMetricWriterService],
})
export class SensorMetricWriterModule {}
