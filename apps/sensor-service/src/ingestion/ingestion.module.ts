import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AutomationModule } from '../automation/automation.module';
import { SensorServiceConfigModule } from '../config/sensor-service-config.module';
import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';
import { ProcessModule } from '../process/process.module';
import { SensorProtocol } from '../database/entities/sensor-protocol.entity';
import { SensorReading } from '../database/entities/sensor-reading.entity';
import { Sensor } from '../database/entities/sensor.entity';
import { EdgeDeviceModule } from '../edge-device/edge-device.module';
import { ReleaseBundleModule } from '../release-bundle/release-bundle.module';
import { ScadaRuntimeModule } from '../scada-runtime/scada-runtime.module';
import { VfdModule } from '../vfd/vfd.module';

import { SensorMetricWriterModule } from './sensor-metric-writer.module';
import { SensorMetricWriterService } from './sensor-metric-writer.service';
import { DataIngestionService } from './data-ingestion.service';
import { DataProcessorService } from './data-processor.service';
import { MqttListenerService } from './mqtt-listener.service';
import { NatsIngestionConsumerService } from './nats-ingestion-consumer.service';
import { SensorCacheInvalidationHandler } from './sensor-cache-invalidation.handler';
import { SensorLookupResponderService } from './sensor-lookup-responder.service';
import { SensorMetaCacheService } from './sensor-meta-cache.service';
import { SensorTopicCacheService } from './sensor-topic-cache.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Sensor, SensorReading, SensorProtocol, SensorDataChannel]),
    // SENSOR-MEDIUM-068 — the one writer for sensor.sensor_metrics, shared with
    // SensorModule's GraphQL path so a single instance owns the store.
    SensorMetricWriterModule,
    EdgeDeviceModule, // For edge device heartbeat handling (no longer circular)
    AutomationModule, // For deployment confirmation in MQTT responses
    ProcessModule, // For ScadaDeployLogService in MQTT response handling
    ReleaseBundleModule, // Faz 5 — bundle ack transitions in MQTT response handling
    SensorServiceConfigModule, // ADR-022 — exports SensorServiceProfileService
    // Live-data producer (SENSOR-HIGH-046): TagValueFanoutService bridges
    // ingested metrics onto the /scada gateway's tenant-fenced fan-out.
    ScadaRuntimeModule,
    // SENSOR-CRITICAL-007 — VfdEdgeWriteService owns the pending-write ack map
    // that the MQTT listener resolves when the edge gateway acknowledges a
    // write_modbus command.
    VfdModule,
  ],
  providers: [
    DataIngestionService,
    MqttListenerService,
    DataProcessorService,
    SensorTopicCacheService,
    // Faz 3 follow-on — extracted sensor + channel cache so the
    // NatsIngestionConsumer (read path) and the SensorCacheInvalidation
    // handler (write path) share one Map per process.
    SensorMetaCacheService,
    // Faz 3 stage 2 — bridges the Rust ingestion sidecar (ADR-025)
    // events into the shared SensorMetricWriterService + typed-event publish
    // path. Co-exists with MqttListenerService until Faz 3 stage 3
    // wires the SENSOR_SERVICE_PROFILE env-gate that disables MQTT
    // entirely on the control-plane profile.
    NatsIngestionConsumerService,
    // Faz 3 follow-on — drops SensorMetaCacheService entries on
    // SensorConfigurationUpdated / Suspended / Reactivated so ops
    // scenarios (channel renames, sensor suspends) do not wait the
    // 60s TTL.
    SensorCacheInvalidationHandler,
    // Faz 3 follow-on — request-reply responder for the Rust
    // sidecar's cache-miss `sensor.lookup.by-topic` request. Backed
    // by SensorMetaCacheService so the sensor + channel lookup
    // shares the same in-memory cache the consumer + invalidation
    // handler use. Without this provider the sidecar's TopicCache
    // would never fill — every message would pay the
    // payload-only-data path.
    SensorLookupResponderService,
  ],
  exports: [
    SensorMetricWriterService,
    DataIngestionService,
    MqttListenerService,
    DataProcessorService,
    SensorTopicCacheService,
    SensorMetaCacheService,
    NatsIngestionConsumerService,
    SensorCacheInvalidationHandler,
    SensorLookupResponderService,
  ],
})
 
export class IngestionModule {}
