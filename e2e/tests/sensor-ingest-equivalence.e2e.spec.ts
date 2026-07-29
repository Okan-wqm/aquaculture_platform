/**
 * Sensor-Ingest Dual-Write Equivalence — Faz 3 stage 4 e2e gate.
 *
 * GATE for Faz 3 PR merge: legacy MQTT path and Rust sidecar path
 * MUST persist byte-equivalent rows for the same MQTT publish.
 *
 * Architectural shape:
 *   1. Test publishes a synthesised metric to the MQTT broker on a
 *      tenant-prefixed topic (`tenants/{tenantId}/devices/{deviceCode}/io_data`).
 *   2. Both backends are LIVE in the dual-write window:
 *      - NestJS sensor-service on `legacy` profile subscribes to MQTT,
 *        validates, writes to `<tenant>.sensor_metrics`.
 *      - Rust sidecar (`sensor-ingestion` container) subscribes to
 *        the same MQTT topic, COPYs to the same hypertable, AND
 *        publishes a `SensorMetricIngested` event onto NATS.
 *      - The control-plane NestJS NATS consumer
 *        (NatsIngestionConsumerService) receives the event, enriches,
 *        calls BatchProcessor.enqueue (which would write a SECOND
 *        row — the dual-write).
 *   3. Test queries the hypertable for rows matching the synthesised
 *      `(tenant, sensor, channel, time)` and asserts EXACTLY ONE row
 *      survives. The dedup arrives from the `INSERT ... ON CONFLICT
 *      DO UPDATE` in PostgresSink + the matching ON CONFLICT in
 *      BatchProcessor.flush — a tenant-correct value gets written
 *      regardless of which backend hits first.
 *   4. Test queries NATS JetStream for the matching
 *      `events.{tenantId}.SensorMetricIngested` and the
 *      `events.{tenantId}.SensorReading` event, asserts both arrived
 *      (the sidecar published the metric event; the consumer
 *      re-emitted the typed reading event).
 *
 * WHY this test must NOT live in `e2e/tests/integration/` (which is
 * the per-PR fast suite):
 *   This is a slow, infrastructure-heavy test that requires:
 *     - A real Mosquitto broker reachable from both backends.
 *     - A real NATS broker with mTLS configured (ADR-014/015).
 *     - A real TimescaleDB with the per-tenant schema bootstrapped.
 *     - The Rust sidecar container (built, tagged, running).
 *   It belongs to a dedicated nightly soak job, not the per-PR gate.
 *   Filename suffix `.e2e.spec.ts` (not `.spec.ts`) opts it out of
 *   the integration suite by jest config convention.
 *
 * GATE SEMANTIC:
 *   This file ships as the SHELL of the test — the assertion shape
 *   is correct, the wiring is correct, but the actual broker + DB
 *   harness depends on the staging deploy that the Faz 3 stage 4
 *   compose update enables. Until that runs, the test is gated by
 *   `SENSOR_INGEST_EQUIVALENCE_E2E=1` and short-circuits to a no-op
 *   PASS so CI is not blocked. When the staging soak harness lands
 *   (operator runs `SENSOR_INGEST_EQUIVALENCE_E2E=1 npx jest …` in
 *   the deploy pipeline), the assertions run for real.
 */

import { randomUUID } from 'crypto';

import type { NatsConnection } from '@nats-io/nats-core';
import { connect as connectNats } from '@nats-io/transport-node';
import { connect as connectMqtt } from 'mqtt';
import { Client as PgClient } from 'pg';

const GATE_ENV = 'SENSOR_INGEST_EQUIVALENCE_E2E';
const PG_URL =
  process.env.SENSOR_INGEST_PG_URL ??
  'postgres://sensor_service:changeme@localhost:5432/aquaculture?sslmode=disable';
const MQTT_URL = process.env.SENSOR_INGEST_MQTT_URL ?? 'mqtt://localhost:1883';
const NATS_URL = process.env.SENSOR_INGEST_NATS_URL ?? 'nats://localhost:4222';
const NATS_TOKEN = process.env.SENSOR_INGEST_NATS_TOKEN;

const isEnabled = process.env[GATE_ENV] === '1';

(isEnabled ? describe : describe.skip)(
  'Sensor-Ingest Dual-Write Equivalence (Faz 3 stage 4 gate)',
  () => {
    let pg: PgClient;
    let nats: NatsConnection;

    const tenantId = randomUUID();
    const sensorId = randomUUID();
    const channelId = randomUUID();

    beforeAll(async () => {
      pg = new PgClient({ connectionString: PG_URL });
      await pg.connect();

      nats = await connectNats({
        servers: NATS_URL,
        ...(NATS_TOKEN ? { token: NATS_TOKEN } : {}),
      });
    }, 60_000);

    afterAll(async () => {
      try {
        await pg.query(
          `DELETE FROM sensor.sensor_metrics WHERE sensor_id = $1`,
          [sensorId],
        );
      } catch {
        // Schema may not exist in dev runs; ignore.
      }
      await pg.end();
      await nats.close();
    }, 60_000);

    it('persists exactly one row per (tenant, sensor, channel, time) under dual-write', async () => {
      const producerTs = Date.now();
      const value = 24.5;
      // OPC-UA GOOD. The wire, the column and every consumer speak ONE scale
      // (sensor-ingestion/src/payload.rs QualityCode); a value like 1 is an
      // OPC-UA BAD code, which is exactly the confusion this spec used to pin.
      const qualityCode = 192;
      const payload = JSON.stringify({
        tenantId,
        sensorId,
        channelId,
        value,
        quality: qualityCode,
        producerTs,
      });

      // 1. Subscribe to NATS BEFORE publishing the MQTT message so we
      //    do not race the publisher.
      const metricSub = nats.subscribe(
        `events.${tenantId}.SensorMetricIngested`,
      );
      const readingSub = nats.subscribe(`events.${tenantId}.SensorReading`);
      const collected: { metric?: unknown; reading?: unknown } = {};
      const metricPromise = (async () => {
        for await (const msg of metricSub) {
          collected.metric = msg.json();
          break;
        }
      })();
      const readingPromise = (async () => {
        for await (const msg of readingSub) {
          collected.reading = msg.json();
          break;
        }
      })();

      // 2. Publish the synthesised metric on MQTT.
      const mqtt = connectMqtt(MQTT_URL);
      await new Promise<void>((resolve, reject) => {
        mqtt.once('connect', () => resolve());
        mqtt.once('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        mqtt.publish(
          `tenants/${tenantId}/devices/${sensorId}/io_data`,
          payload,
          { qos: 1 },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      await new Promise<void>((resolve) => mqtt.end(false, {}, () => resolve()));

      // 3. Wait for both events (the sidecar publishes the metric;
      //    the consumer re-emits the typed reading).
      await Promise.race([
        Promise.all([metricPromise, readingPromise]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('NATS event timeout 30s')), 30_000),
        ),
      ]);

      // 4. Assert exactly one row in the hypertable for this composite key.
      const result = await pg.query(
        `SELECT COUNT(*)::int AS n, MAX(value)::float AS v, MAX(quality_code)::int AS q
         FROM sensor.sensor_metrics
         WHERE sensor_id = $1 AND channel_id = $2 AND time = to_timestamp($3 / 1000.0)`,
        [sensorId, channelId, producerTs],
      );
      const row = result.rows[0] as { n: number; v: number; q: number };
      expect(row.n).toBe(1);
      expect(row.v).toBeCloseTo(value, 4);
      expect(row.q).toBe(qualityCode);

      // 5. Wire-shape sanity: the metric event the sidecar published
      //    is camelCase (ADR-006) and carries the channelId we sent.
      const metric = collected.metric as Record<string, unknown>;
      expect(metric.eventType).toBe('SensorMetricIngested');
      expect(metric.tenantId).toBe(tenantId);
      expect(metric.sensorId).toBe(sensorId);
      expect(metric.channelId).toBe(channelId);
      expect(metric.value).toBeCloseTo(value, 4);
      expect(metric.qualityCode).toBe(qualityCode);
      expect(metric.producerTs).toBe(producerTs);

      // 6. The typed reading event the NestJS consumer re-emitted
      //    carries the same tenant + sensor and (channel-key permitting)
      //    a populated readingXxx field. We do not assert which field
      //    here because the synthesised channelId may not map to a
      //    known channelKey in the test DB; the presence of the event
      //    proves the consumer ran.
      const reading = collected.reading as Record<string, unknown>;
      expect(reading.eventType).toBe('SensorReading');
      expect(reading.tenantId).toBe(tenantId);
      expect(reading.sensorId).toBe(sensorId);
    }, 60_000);
  },
);

// When the gate env is unset, jest sees zero `it` blocks for this
// describe.skip — which it would emit a console warning about. Add a
// trivial passing case so the suite reports cleanly in the unsoaked
// CI runs.
if (!isEnabled) {
  describe('Sensor-Ingest Dual-Write Equivalence (gated)', () => {
    it(`is skipped because ${GATE_ENV}!=1 (set to 1 in the soak job)`, () => {
      expect(isEnabled).toBe(false);
    });
  });
}
