/**
 * Sensor Readings & Metrics E2E Tests
 *
 * Tests reading ingestion, batch ingestion, time-range queries,
 * aggregated readings, batch latest readings, and cross-tenant isolation.
 *
 * Resolver: SensorResolver (sensor.resolver.ts)
 * Operations: ingestReading, batchIngestReadings, readings, aggregatedReadings,
 *             latestReading, latestReadingsBatch
 *
 * @module Sensor-Service/E2E/SensorReadings
 */
import { assertDefined } from '../../../helpers/assertions';

import { gql, TENANT_A, TENANT_B, uniqueSerial, uniqueName, runCleanup } from './helpers';

// ============================================================================
// GRAPHQL OPERATIONS
// ============================================================================

// SENSOR-MEDIUM-064: the createSensor back door was removed; registerSensor
// is the single write path. These reading tests only need a persisted sensor
// to ingest against, so they register with skipConnectionTest.
const REGISTER_SENSOR = `
  mutation registerSensor($input: RegisterSensorInput!) {
    registerSensor(input: $input) {
      success
      sensor {
        id
        name
        serialNumber
        type
        registrationStatus
        tenantId
      }
      error
    }
  }
`;

const INGEST_READING = `
  mutation ingestReading($input: IngestReadingInput!) {
    ingestReading(input: $input) {
      id
      sensorId
      tenantId
      timestamp
      readings {
        temperature
        ph
        dissolvedOxygen
        salinity
        ammonia
        nitrite
        nitrate
        turbidity
        waterLevel
      }
      source
    }
  }
`;

const BATCH_INGEST_READINGS = `
  mutation batchIngestReadings($input: BatchIngestInput!) {
    batchIngestReadings(input: $input)
  }
`;

const LATEST_READING = `
  query latestReading($sensorId: ID!) {
    latestReading(sensorId: $sensorId) {
      id
      sensorId
      tenantId
      timestamp
      readings {
        temperature
        ph
        dissolvedOxygen
        salinity
      }
    }
  }
`;

const LATEST_READINGS_BATCH = `
  query latestReadingsBatch($sensorIds: [ID!]!) {
    latestReadingsBatch(sensorIds: $sensorIds) {
      id
      sensorId
      tenantId
      timestamp
      readings {
        temperature
        ph
        dissolvedOxygen
      }
    }
  }
`;

const READINGS_IN_RANGE = `
  query readings($sensorId: ID!, $startTime: DateTime!, $endTime: DateTime!, $limit: Int) {
    readings(sensorId: $sensorId, startTime: $startTime, endTime: $endTime, limit: $limit) {
      id
      sensorId
      tenantId
      timestamp
      readings {
        temperature
        ph
        dissolvedOxygen
        salinity
      }
    }
  }
`;

const AGGREGATED_READINGS = `
  query aggregatedReadings($sensorId: ID!, $startTime: DateTime!, $endTime: DateTime!, $interval: AggregationInterval) {
    aggregatedReadings(sensorId: $sensorId, startTime: $startTime, endTime: $endTime, interval: $interval) {
      sensorId
      interval
      startTime
      endTime
      totalDataPoints
      data {
        bucket
        count
        avgTemperature
        minTemperature
        maxTemperature
        avgPh
        avgDissolvedOxygen
      }
    }
  }
`;

// ============================================================================
// TESTS
// ============================================================================

describe('Sensor Readings & Metrics', () => {
  let sensorId: string;
  let sensorId2: string;

  beforeAll(async () => {
    // Register sensors for reading tests (single write path).
    const res1 = await gql(REGISTER_SENSOR, {
      input: {
        name: uniqueName('ReadingSensor1'),
        type: 'multi_parameter',
        protocolCode: 'mqtt',
        protocolConfiguration: { topic: 'sensors/readings/1' },
        serialNumber: uniqueSerial('RDG1'),
        skipConnectionTest: true,
      },
    });
    const result1 = assertDefined(res1.data).registerSensor as Record<string, unknown>;
    sensorId = (result1.sensor as Record<string, unknown>).id as string;

    const res2 = await gql(REGISTER_SENSOR, {
      input: {
        name: uniqueName('ReadingSensor2'),
        type: 'temperature',
        protocolCode: 'mqtt',
        protocolConfiguration: { topic: 'sensors/readings/2' },
        serialNumber: uniqueSerial('RDG2'),
        skipConnectionTest: true,
      },
    });
    const result2 = assertDefined(res2.data).registerSensor as Record<string, unknown>;
    sensorId2 = (result2.sensor as Record<string, unknown>).id as string;
  });

  afterAll(async () => {
    await runCleanup();
  });

  // ------------------------------------------------------------------
  // Test 1: ingestReading(sensorId, readings) -> latestReading verify
  // ------------------------------------------------------------------
  describe('Test 1: Ingest single reading', () => {
    it('should ingest a reading and return stored result', async () => {
      const res = await gql(INGEST_READING, {
        input: {
          sensorId,
          readings: {
            temperature: 25.5,
            ph: 7.2,
            dissolvedOxygen: 6.8,
            salinity: 15.3,
          },
        },
      });

      expect(res.errors).toBeUndefined();
      const reading = assertDefined(res.data).ingestReading as Record<string, unknown>;
      expect(reading.sensorId).toBe(sensorId);
      expect(reading.tenantId).toBe(TENANT_A.id);
      expect(reading.timestamp).toBeDefined();
      expect(reading.source).toBe('graphql');

      const readings = reading.readings as Record<string, number>;
      expect(readings.temperature).toBe(25.5);
      expect(readings.ph).toBe(7.2);
      expect(readings.dissolvedOxygen).toBe(6.8);
      expect(readings.salinity).toBe(15.3);
    });

    it('should retrieve the latest reading for the sensor', async () => {
      const res = await gql(LATEST_READING, { sensorId });

      expect(res.errors).toBeUndefined();
      const reading = assertDefined(res.data).latestReading as Record<string, unknown>;
      expect(reading).toBeDefined();
      expect(reading.sensorId).toBe(sensorId);
      expect(reading.tenantId).toBe(TENANT_A.id);

      const readings = reading.readings as Record<string, number>;
      expect(readings.temperature).toBe(25.5);
    });
  });

  // ------------------------------------------------------------------
  // Test 2: batchIngestReadings -> count verify
  // ------------------------------------------------------------------
  describe('Test 2: Batch ingest readings', () => {
    it('should batch ingest multiple readings and return count', async () => {
      const batchReadings = [
        {
          sensorId,
          readings: { temperature: 26.0, ph: 7.3 },
          timestamp: new Date(Date.now() - 60000).toISOString(),
        },
        {
          sensorId,
          readings: { temperature: 26.5, ph: 7.4 },
          timestamp: new Date(Date.now() - 30000).toISOString(),
        },
        {
          sensorId: sensorId2,
          readings: { temperature: 24.0 },
          timestamp: new Date().toISOString(),
        },
      ];

      const res = await gql(BATCH_INGEST_READINGS, {
        input: { readings: batchReadings },
      });

      expect(res.errors).toBeUndefined();
      const count = assertDefined(res.data).batchIngestReadings as number;
      expect(count).toBe(3);
    });
  });

  // ------------------------------------------------------------------
  // Test 3: readings(sensorId, timeRange) -> readings in range
  // ------------------------------------------------------------------
  describe('Test 3: Query readings in time range', () => {
    it('should return readings within specified time range', async () => {
      const endTime = new Date();
      const startTime = new Date(Date.now() - 3600000); // 1 hour ago

      const res = await gql(READINGS_IN_RANGE, {
        sensorId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        limit: 100,
      });

      expect(res.errors).toBeUndefined();
      const readings = assertDefined(res.data).readings as Array<Record<string, unknown>>;
      expect(Array.isArray(readings)).toBe(true);

      for (const r of readings) {
        expect(r.sensorId).toBe(sensorId);
        expect(r.tenantId).toBe(TENANT_A.id);

        const ts = new Date(r.timestamp as string);
        expect(ts.getTime()).toBeGreaterThanOrEqual(startTime.getTime());
        expect(ts.getTime()).toBeLessThanOrEqual(endTime.getTime());
      }
    });

    it('should return empty array for time range with no data', async () => {
      const startTime = new Date('2020-01-01');
      const endTime = new Date('2020-01-02');

      const res = await gql(READINGS_IN_RANGE, {
        sensorId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });

      expect(res.errors).toBeUndefined();
      const readings = assertDefined(res.data).readings as Array<Record<string, unknown>>;
      expect(readings.length).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  // Test 4: aggregatedReadings(sensorId, interval) -> avg, min, max
  // ------------------------------------------------------------------
  describe('Test 4: Aggregated readings', () => {
    beforeAll(async () => {
      // Ingest more readings for aggregation
      const batchReadings = [];
      for (let i = 0; i < 10; i++) {
        batchReadings.push({
          sensorId,
          readings: {
            temperature: 20 + i,
            ph: 6.5 + i * 0.1,
            dissolvedOxygen: 5.0 + i * 0.2,
          },
          timestamp: new Date(Date.now() - i * 60000).toISOString(),
        });
      }

      await gql(BATCH_INGEST_READINGS, {
        input: { readings: batchReadings },
      });
    });

    it('should return aggregated readings with 1-hour interval', async () => {
      const endTime = new Date();
      const startTime = new Date(Date.now() - 3600000);

      const res = await gql(AGGREGATED_READINGS, {
        sensorId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        interval: '1 hour',
      });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).aggregatedReadings as Record<string, unknown>;
      expect(result.sensorId).toBe(sensorId);
      expect(result.interval).toBeDefined();
      expect(result.totalDataPoints).toBeDefined();

      const data = result.data as Array<Record<string, unknown>>;
      expect(Array.isArray(data)).toBe(true);

      // Each data point should have bucket, count, and aggregated fields
      for (const point of data) {
        expect(point.bucket).toBeDefined();
        expect(typeof point.count).toBe('number');
        // avg/min/max fields are nullable but should be present
        if (point.avgTemperature !== null) {
          expect(typeof point.avgTemperature).toBe('number');
        }
      }
    });

    it('should auto-select interval when not specified', async () => {
      const endTime = new Date();
      const startTime = new Date(Date.now() - 86400000); // 24 hours

      const res = await gql(AGGREGATED_READINGS, {
        sensorId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        // No interval -> auto-select
      });

      expect(res.errors).toBeUndefined();
      const result = assertDefined(res.data).aggregatedReadings as Record<string, unknown>;
      expect(result.interval).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // Test 5: latestReadingsBatch(sensorIds[]) -> batch query
  // ------------------------------------------------------------------
  describe('Test 5: Batch latest readings', () => {
    it('should return latest readings for multiple sensors', async () => {
      const res = await gql(LATEST_READINGS_BATCH, {
        sensorIds: [sensorId, sensorId2],
      });

      expect(res.errors).toBeUndefined();
      const readings = assertDefined(res.data).latestReadingsBatch as Array<
        Record<string, unknown>
      >;
      expect(Array.isArray(readings)).toBe(true);

      // Should return at most one reading per sensor
      const sensorIds = readings.map((r) => r.sensorId);
      const uniqueSensorIds = [...new Set(sensorIds)];
      expect(uniqueSensorIds.length).toBe(sensorIds.length);

      // All readings should belong to Tenant A
      for (const r of readings) {
        expect(r.tenantId).toBe(TENANT_A.id);
      }
    });
  });

  // ------------------------------------------------------------------
  // Test 6: Cross-tenant isolation
  // ------------------------------------------------------------------
  describe('Test 6: Cross-tenant reading isolation', () => {
    it('Tenant B should NOT see Tenant A latest reading', async () => {
      const res = await gql(LATEST_READING, { sensorId }, TENANT_B);

      // Should return null (tenant isolation in QueryService)
      if (res.data?.latestReading) {
        expect(res.data.latestReading).toBeNull();
      }
      // Or might return error
    });

    it('Tenant B should NOT see Tenant A readings in time range', async () => {
      const endTime = new Date();
      const startTime = new Date(Date.now() - 3600000);

      const res = await gql(
        READINGS_IN_RANGE,
        {
          sensorId,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
        },
        TENANT_B,
      );

      if (res.errors) {
        // Expected: not found or unauthorized
        expect(res.errors.length).toBeGreaterThan(0);
      } else {
        const readings = res.data?.readings as Array<Record<string, unknown>>;
        expect(readings.length).toBe(0);
      }
    });

    it('Tenant B batch query with Tenant A sensorId should return empty', async () => {
      const res = await gql(LATEST_READINGS_BATCH, { sensorIds: [sensorId] }, TENANT_B);

      expect(res.errors).toBeUndefined();
      const readings = assertDefined(res.data).latestReadingsBatch as Array<
        Record<string, unknown>
      >;
      expect(readings.length).toBe(0);
    });
  });
});
