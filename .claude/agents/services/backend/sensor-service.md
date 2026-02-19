---
name: sensor-service
description: Knowledge base for sensor-service - TimescaleDB, MQTT ingestion, VFD protocol adapters, automation, calibration, edge device management, stream processing
---

# Sensor Service Knowledge Base

## Overview
The sensor-service handles all IoT/sensor data for the aquaculture platform. It ingests sensor readings via MQTT, stores time-series data in TimescaleDB (PostgreSQL extension), manages VFDs (Variable Frequency Drives), industrial protocol adapters (Modbus, BACnet, OPC UA, EtherCAT, etc.), edge device provisioning, IEC 61131-3 automation programs, PLC control, sensor registration/calibration, and real-time stream processing. Port 3003 in local dev.

## Directory Structure
```
apps/sensor-service/src/
  app.module.ts              # Root - TypeORM (explicit entities), GraphQL Fed v2, NATS, SharedMqttModule
  main.ts
  middleware/
    tenant-schema.middleware.ts   # Sets search_path: "tenant_xxx", public
  filters/
    global-exception.filter.ts

  # ===================== DATABASE / TIME-SERIES =====================
  database/
    entities/
      sensor.entity.ts            # Sensor definition (type, unit, tankId, metadata)
      sensor-reading.entity.ts    # Time-series readings (hypertable in TimescaleDB)
      sensor-protocol.entity.ts   # Protocol configuration for each sensor
      sensor-data-channel.entity.ts  # Data channels per sensor
      sensor-metadata.entity.ts
    migrations/
      1735900000000-CreateSensorMetrics.ts
      1735900001000-CreateContinuousAggregates.ts
      1736200000000-CreateReadingsAggregates.ts
      1736800000000-CreateEdgeDevicesTable.ts

  # ===================== TIMESCALE =====================
  timescale/
    timescale.module.ts
    hypertable.service.ts           # Creates/manages TimescaleDB hypertables
    continuous-aggregate.service.ts # Manages materialized views for aggregation
    retention-policy.service.ts     # Manages data retention policies

  # ===================== MQTT =====================
  mqtt/
    mqtt.module.ts
    mqtt-client.service.ts          # MQTT connection management
    mqtt-publisher.service.ts       # Publishes commands to devices
    mqtt-subscriber.service.ts      # Subscribes to sensor data topics
  shared-mqtt/
    shared-mqtt.module.ts           # @Global MQTT module shared across all modules

  # ===================== INGESTION =====================
  ingestion/
    ingestion.module.ts
    data-processor.service.ts       # Main processing pipeline
    batch-processor.service.ts      # Batch writes for performance
    validation.service.ts           # Data range/type validation

  # ===================== SENSOR MANAGEMENT =====================
  sensor/
    sensor.module.ts
    dto/
      aggregated-reading.dto.ts

  registration/
    registration.module.ts
    services/
      sensor-registration.service.ts   # Register new sensors
      channel-management.service.ts    # Manage sensor data channels
      channel-discovery.service.ts     # Auto-discover channels from device

  calibration/
    calibration.entity.ts            # Calibration records per sensor
    calibration.service.ts           # Apply calibration offsets
    drift-detection.service.ts       # Detect sensor drift

  # ===================== DATA QUALITY =====================
  cleaning/
    data-cleaner.service.ts          # Orchestrates data cleaning pipeline
    interpolation.service.ts         # Interpolates missing values
    outlier-detection.service.ts     # Detects and flags outliers

  aggregation/
    rollup.service.ts                # Data rollup to lower resolution
    statistical-aggregator.service.ts  # Min, max, avg, stddev computations
    time-bucket.service.ts           # TimescaleDB time_bucket queries

  stream-processing/
    anomaly-detector.service.ts      # Real-time anomaly detection
    kafka-streams.service.ts         # Kafka Streams integration (if used)
    real-time-analyzer.service.ts    # Real-time signal analysis

  # ===================== PROTOCOL ADAPTERS =====================
  protocol/
    protocol.module.ts
    adapters/
      base-protocol.adapter.ts       # Abstract base adapter
      industrial/
        allen-bradley-df1.adapter.ts
        allen-bradley-ethernet.adapter.ts
        bacnet-ip.adapter.ts
        bacnet-mstp.adapter.ts
        canopen.adapter.ts
        cclink.adapter.ts             # CC-Link (Mitsubishi)
        devicenet.adapter.ts
        ethercat.adapter.ts
        ethernet-ip.adapter.ts        # EtherNet/IP (Allen-Bradley)
        knx-ip.adapter.ts
        mitsubishi-mc.adapter.ts
        profibus-dp.adapter.ts
        schneider-modicon.adapter.ts
      iot/
        amqp.adapter.ts
        coap.adapter.ts               # CoAP (Constrained Application Protocol)
        dds.adapter.ts                # DDS (Data Distribution Service)
        http-rest.adapter.ts
      serial/
        i2c.adapter.ts
        one-wire.adapter.ts           # 1-Wire (Dallas/Maxim)
        rs232.adapter.ts
        rs485.adapter.ts              # RS-485/Modbus RTU common
        spi.adapter.ts
        tcp-socket.adapter.ts
        udp-socket.adapter.ts
      wireless/
        ble.adapter.ts                # Bluetooth Low Energy
        esp-now.adapter.ts            # ESP-NOW (ESP8266/ESP32)
        lorawan.adapter.ts            # LoRaWAN for long-range sensors
        thread-matter.adapter.ts      # Thread/Matter protocol
        zigbee.adapter.ts
        zwave.adapter.ts
    services/
      connection-tester.service.ts
      protocol-validator.service.ts

  # ===================== VFD (Variable Frequency Drives) =====================
  vfd/
    vfd.module.ts
    entities/
      vfd-device.entity.ts           # VFD device registration
      vfd-reading.entity.ts          # VFD readings (speed, current, power)
      vfd-register-mapping.entity.ts # Modbus register mappings
    adapters/
      base-vfd.adapter.ts
      vfd-bacnet.adapter.ts
      vfd-canopen.adapter.ts
      vfd-ethernet-ip.adapter.ts
      vfd-modbus-rtu.adapter.ts
      vfd-modbus-tcp.adapter.ts      # Most common VFD protocol
      vfd-profibus-dp.adapter.ts
      vfd-profinet.adapter.ts
    resolvers/ (vfd-device, vfd-command resolvers)
    services/
    dto/

  # ===================== AUTOMATION (IEC 61131-3) =====================
  automation/
    automation.module.ts
    entities/
      automation-program.entity.ts   # SFC (Sequential Function Chart) program
      program-step.entity.ts         # Steps in the SFC
      step-action.entity.ts          # Actions within a step
      program-transition.entity.ts   # Transitions between steps
      program-variable.entity.ts     # Program variables
    dto/

  # ===================== PLC CONTROL (OPC UA) =====================
  plc-control/
    plc-control.module.ts
    entities/
      plc-connection.entity.ts       # OPC UA server connection config
      feeding-parameter.entity.ts    # Feeder parameters sent to PLC
      plc-alarm.entity.ts            # PLC alarm records
      plc-telemetry.entity.ts        # PLC telemetry data

  # ===================== EDGE DEVICES =====================
  edge-device/
    edge-device.module.ts
    entities/
      edge-device.entity.ts          # Edge device registration (Raspberry Pi, etc.)
      device-io-config.entity.ts     # I/O channel configuration per device

  # ===================== DASHBOARD / PROCESS =====================
  dashboard/
    dashboard.module.ts
    dashboard.service.ts
    entities/
      dashboard-layout.entity.ts     # Saved dashboard layouts per user

  process/
    process.module.ts
    entities/
      process.entity.ts              # Equipment connection diagrams

  # ===================== HEALTH =====================
  health/
    health.module.ts
  config/
    app.config.ts
    mqtt.config.ts
    timescale.config.ts
```

## Modules & Features

### SensorModule
Core sensor management: register sensors, manage metadata, query readings.

### IngestionModule
- MQTT topic listener (`sensor/{tenantId}/{deviceId}/{channelId}` format)
- `DataProcessorService`: validates -> calibrates -> cleans -> stores reading
- `BatchProcessorService`: batches writes for TimescaleDB efficiency

### TimescaleModule
- `HypertableService`: creates TimescaleDB hypertables for `sensor_readings`
- `ContinuousAggregateService`: manages 5-min, 1-hour, 1-day materialized views
- `RetentionPolicyService`: configures automatic data expiry

### ProtocolModule
- `ProtocolModule.forRoot()` - dynamic module with all protocol adapters registered
- Adapters implement `BaseProtocolAdapter` interface
- Supports 20+ protocols: industrial (BACnet, Profibus, EtherNet/IP, CANopen, CC-Link), IoT (MQTT, CoAP, AMQP, DDS), serial (RS-485, RS-232, I2C, SPI, 1-Wire), wireless (BLE, LoRaWAN, Zigbee, Z-Wave, ESP-NOW, Thread/Matter)

### VfdModule
- VFD device registration and control
- Modbus TCP is the most common protocol for VFDs
- Tracks speed, current, power, frequency
- Register mapping for different VFD brands (Siemens, ABB, Schneider, etc.)

### AutomationModule
- IEC 61131-3 SFC (Sequential Function Chart) program execution
- Programs have steps, transitions, actions, and variables
- Used for automated feeding sequences, water treatment cycles

### PlcControlModule
- OPC UA-based PLC communication
- Sends feeding parameters to PLCs
- Reads PLC alarms and telemetry

### EdgeDeviceModule
- Registers edge devices (Raspberry Pi, industrial gateways)
- Manages I/O channel configurations per device
- Created via migration `1736800000000-CreateEdgeDevicesTable.ts`

### SharedMqttModule (@Global)
- Provides `MqttClientService` to all modules without re-importing
- Single MQTT connection per service instance

### RegistrationModule
- Sensor self-registration flow
- Channel discovery (auto-detects channels from device announcement)
- Channel management (enable/disable, rename)

### CalibrationModule (not a NestJS module, services only)
- Records calibration events (offset, gain, polynomial coefficients)
- `DriftDetectionService`: detects calibration drift over time

### DataCleaningServices
- `OutlierDetectionService`: statistical outlier flagging (IQR, z-score)
- `InterpolationService`: fills gaps in time series
- `DataCleanerService`: orchestrates the pipeline

### AggregationServices
- `StatisticalAggregatorService`: computes min/max/avg/stddev for time windows
- `TimeBucketService`: wraps TimescaleDB `time_bucket()` for efficient queries
- `RollupService`: downsamples data to lower resolution

### StreamProcessingServices
- `AnomalyDetectorService`: real-time anomaly detection on incoming readings
- `RealTimeAnalyzerService`: runs analysis algorithms on streaming data

## Key Entities

### Sensor
- `deviceId`, `channelId`, `type` (pH, DO, temperature, salinity, turbidity)
- `unit`, `tankId`, `farmId`, `tenantId`
- `protocolId`, `isActive`, `lastReadingAt`

### SensorReading (TimescaleDB hypertable)
- `time` (timestamptz - partition key), `sensorId`, `value`, `unit`
- `tenantId`, `tankId`, `quality` (good/bad/uncertain)
- Partitioned by time for efficient time-range queries

### VfdDevice
- `name`, `protocol` (modbus_tcp, profibus, etc.), `ipAddress`, `port`
- `unitId`, `tenantId`, `equipmentId` (links to farm-service equipment)

### EdgeDevice
- `deviceId`, `type`, `status`, `firmwareVersion`
- `ipAddress`, `lastSeenAt`, `tenantId`

### AutomationProgram
- `name`, `description`, `status` (DRAFT, ACTIVE, PAUSED, COMPLETED)
- Has steps, transitions, variables

## API / GraphQL (sensor subgraph)
All major sensor entities have resolvers.

### Key Queries
- `sensors`, `sensor`, `sensorReadings`, `latestReading`
- `aggregatedReadings(sensorId, from, to, interval)`
- `vfdDevices`, `vfdReadings`
- `edgeDevices`, `edgeDevice`
- `automationPrograms`, `automationProgram`
- `dashboardLayout`

### Key Mutations
- `registerSensor`, `updateSensor`, `deactivateSensor`
- `recordReading` (manual), `calibrateSensor`
- `registerVfdDevice`, `sendVfdCommand`
- `registerEdgeDevice`, `updateDeviceIoConfig`
- `createAutomationProgram`, `startProgram`, `pauseProgram`
- `saveDashboardLayout`

## Patterns Used
- **TimescaleDB hypertables** for time-series storage (automatic partitioning by time)
- **Continuous aggregates** for pre-computed statistics (5min, 1hr, 1day)
- **Adapter pattern** for protocol implementations (all implement BaseProtocolAdapter)
- **MQTT pub/sub** for real-time ingestion
- **TenantSchemaMiddleware** for tenant isolation
- **TenantGuard + RolesGuard** applied globally

## Inter-Service Communication
- Publishes NATS events: `SensorReadingIngested`, `AlertThresholdExceeded`, `SensorOffline`
- alert-engine subscribes to `SensorReadingIngested` for rule evaluation
- gateway-api bridges sensor readings to WebSocket clients via NATS

## Key Dependencies
- `@nestjs/typeorm` with PostgreSQL (TimescaleDB extension required)
- `mqtt` / `aedes` - MQTT client
- `@platform/event-bus` - NATS JetStream
- `graphql-depth-limit`, `graphql-query-complexity` - security
- TimescaleDB: `time_bucket()`, `create_hypertable()`, continuous aggregates

## Known Gotchas
- **Explicit entity list** - sensor-service uses explicit entity array in TypeORM config (not `autoLoadEntities`), required for webpack bundle compatibility
- **ALL sensor-service columns need explicit `name:` mapping** - the DB uses snake_case, no global SnakeNamingStrategy. See MEMORY.md: `@Column({ type: 'uuid', name: 'tenant_id' })` for `tenantId`
- **TimescaleDB required** - the database must have the TimescaleDB extension installed; raw PostgreSQL will fail on hypertable creation
- **Continuous aggregates use raw SQL** - migrations that create views must use DB column names (snake_case), not TypeORM entity field names
- **search_path for sensor**: `"tenant_xxx", public` (no `sensor` schema fallback unlike farm)
- **SharedMqttModule is @Global** - import once in AppModule, available everywhere

## Related Services
- farm-service: sensor readings linked to tanks and farms
- alert-engine: consumes sensor readings for alert rule evaluation
- gateway-api: WebSocket bridge for real-time readings
- edge devices: send data via MQTT to this service
