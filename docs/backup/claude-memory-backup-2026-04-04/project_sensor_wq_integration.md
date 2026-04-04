---
name: Sensor-driven water quality data entry
description: Future requirement — water quality measurements should also be auto-created from sensor readings (MQTT/Modbus), not just manual entry. Architecture must support manual + sensor + lab sources.
type: project
---

Water quality measurement entry has 3 planned sources:
1. **Manual** — web panel + AquaMobil (implementing now)
2. **Sensor** — automatic from sensor-service via MQTT/NATS events (future)
3. **Lab** — lab analysis results import (future)

The `MeasurementSource` enum already covers all 3: `MANUAL`, `SENSOR_AUTOMATIC`, `SENSOR_TRIGGERED`, `LAB_ANALYSIS`, `CALIBRATION`.

**Why:** Sensor data from sensor-service (TimescaleDB, MQTT ingestion) can auto-create WaterQualityMeasurement records when readings arrive. The `sensorId` field on both `WaterQualityMeasurement` and `WaterQualityParamEquipment` entities already support this linkage.

**How to apply:** When building measurement creation flows, always design for the `source` field to be set correctly. When sensor integration is built, it will publish a NATS event that farm-service consumes to auto-create measurements.
