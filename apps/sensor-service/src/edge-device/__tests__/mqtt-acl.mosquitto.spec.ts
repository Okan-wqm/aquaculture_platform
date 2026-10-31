import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import mqtt from 'mqtt';

import { bootMosquittoContainer, type MqttHarness } from '@platform/mqtt-test-harness';

import {
  BROKER_AUTH_SECRET,
  LISTENER_CLIENT_ID,
  SENSOR_SERVICE_PASSWORD,
  mosquittoHash,
  platformBrokerAuth,
  startAuthBackend,
} from '../../__tests__/support/platform-broker-auth.harness';
import { DeviceLifecycleState, EdgeDevice } from '../entities/edge-device.entity';
import { SENSOR_SERVICE_SUBSCRIPTION_FILTERS } from '../../ingestion/mqtt-listener.service';
import {
  SENSOR_MQTT_DATA_FILTER,
  sensorMqttDataTopic,
} from '../../mqtt-identity/sensor-mqtt-topic';

/**
 * SENSOR-HIGH-118 end-to-end: real Mosquitto + real go-auth + the real
 * MqttAuthService decision path. This is the only test class that can catch
 * "ACL code says yes but Mosquitto 2.x asks acc=4 on wildcard SUBSCRIBEs and
 * one 0x80 kills the whole batch" — the exact failure that left production
 * subscribed to nothing.
 *
 * Gated behind MQTT_ACL_E2E=1 (same convention as
 * SENSOR_INGEST_EQUIVALENCE_E2E) because it needs Docker and the platform
 * mosquitto image (override with MQTT_TEST_BROKER_IMAGE). CI runs it through
 * `sensor-service:test:broker` whenever the broker config, the harness or the
 * MQTT auth and identity code changes (ADR-047 §3: a sensor's topic names its
 * publisher only because this ACL holds).
 */

const RUN = process.env['MQTT_ACL_E2E'] === '1';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GATEWAY_PASSWORD = 'test-gateway-password';
const ACTIVE_GATEWAY = 'edge-aaaaaaaa-pond-01';
const PENDING_GATEWAY = 'edge-aaaaaaaa-pond-02';
/** A sensor's own principal (ADR-047) and the one topic it may publish to. */
const SENSOR_USERNAME = `s${'k'.repeat(22)}`;
const SENSOR_SECRET = 'test-sensor-principal-secret';
const SENSOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_SENSOR_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SENSOR_TOPIC = sensorMqttDataTopic(TENANT, SENSOR_ID);
const OTHER_SENSOR_TOPIC = sensorMqttDataTopic(TENANT, OTHER_SENSOR_ID);

function gateway(mqttClientId: string, lifecycleState: DeviceLifecycleState): EdgeDevice {
  const device = new EdgeDevice();
  device.id = randomUUID();
  device.tenantId = TENANT;
  device.deviceCode = mqttClientId === ACTIVE_GATEWAY ? 'POND-01' : 'POND-02';
  device.mqttClientId = mqttClientId;
  device.mqttPasswordHash = mosquittoHash(GATEWAY_PASSWORD);
  device.lifecycleState = lifecycleState;
  return device;
}

function subscribeGrants(
  client: mqtt.MqttClient,
  topics: string[],
): Promise<Array<{ filter: string; qos: number }>> {
  return new Promise((resolve, reject) => {
    client.subscribe(topics, { qos: 1 }, (err, granted) => {
      if (err) reject(err);
      else resolve((granted ?? []).map((g) => ({ filter: g.topic, qos: g.qos })));
    });
  });
}

(RUN ? describe : describe.skip)(
  'sensor_service SUBACK contract on real Mosquitto (SENSOR-HIGH-118)',
  () => {
    jest.setTimeout(240_000);

    let harness: MqttHarness | undefined;
    let backend: { server: Server; port: number } | undefined;
    let client: mqtt.MqttClient | undefined;

    beforeAll(async () => {
      const service = platformBrokerAuth({
        gateways: [
          gateway(ACTIVE_GATEWAY, DeviceLifecycleState.ACTIVE),
          gateway(PENDING_GATEWAY, DeviceLifecycleState.PENDING_APPROVAL),
        ],
        sensors: [
          {
            principal: {
              username: SENSOR_USERNAME,
              tenantId: TENANT,
              sensorId: SENSOR_ID,
              secret: { hmac: 'unused', kid: 'unused' },
            },
            secret: SENSOR_SECRET,
          },
        ],
      });
      backend = await startAuthBackend(service);
      harness = await bootMosquittoContainer({
        authBackendPort: backend.port,
        authSecret: BROKER_AUTH_SECRET,
        startTimeoutMs: 120_000,
      });

      client = await mqtt.connectAsync(`mqtt://${harness.host}:${harness.port}`, {
        username: 'sensor_service',
        password: SENSOR_SERVICE_PASSWORD,
        clientId: LISTENER_CLIENT_ID,
        clean: true,
        connectTimeout: 10_000,
      });
    });

    afterAll(async () => {
      if (process.env['MQTT_ACL_E2E_DEBUG'] && harness) {
        console.log('BROKER_LOGS:', harness.capturedLogs().slice(-40).join('\n'));
      }
      await client?.endAsync().catch(() => undefined);
      await harness?.stop();
      backend?.server.close();
    });

    it('authenticates sensor_service against the real go-auth http backend', () => {
      expect(client?.connected).toBe(true);
    });

    it('subscribes EVERY listener filter with a granted QoS (no 0x80 anywhere)', async () => {
      const grants = await subscribeGrants(client!, [...SENSOR_SERVICE_SUBSCRIPTION_FILTERS]);
      const denied = grants.filter((g) => g.qos === 128);
      expect(denied).toEqual([]);
      expect(grants).toHaveLength(SENSOR_SERVICE_SUBSCRIPTION_FILTERS.length);
    });

    it('denies the broad tenants/+/devices/+/# wildcard (SEC-MEDIUM-130 preserved)', async () => {
      // mqtt.js v5 surfaces a SUBACK 0x80 as a rejected subscribe promise.
      await expect(subscribeGrants(client!, ['tenants/+/devices/+/#'])).rejects.toThrow();
    });

    it('refuses known-good gateway credentials under a foreign client ID right after a grant (no plugin auth cache)', async () => {
      // go-auth keys its auth cache on username+password only. With the cache
      // that production used to run (5 s), this second CONNECT was answered
      // from the cache and the client-ID binding (SENSOR-HIGH-144) never ran.
      const own = await mqtt.connectAsync(`mqtt://${harness!.host}:${harness!.port}`, {
        username: ACTIVE_GATEWAY,
        password: GATEWAY_PASSWORD,
        clientId: `${ACTIVE_GATEWAY}-POND-01`,
        clean: true,
        connectTimeout: 10_000,
        reconnectPeriod: 0,
      });
      expect(own.connected).toBe(true);
      await own.endAsync();

      await expect(
        mqtt.connectAsync(`mqtt://${harness!.host}:${harness!.port}`, {
          username: ACTIVE_GATEWAY,
          password: GATEWAY_PASSWORD,
          clientId: 'aqua-sensor-service-main',
          clean: true,
          connectTimeout: 10_000,
          reconnectPeriod: 0,
        }),
      ).rejects.toThrow();
    });

    it('refuses a PENDING_APPROVAL gateway that holds a valid password', async () => {
      await expect(
        mqtt.connectAsync(`mqtt://${harness!.host}:${harness!.port}`, {
          username: PENDING_GATEWAY,
          password: GATEWAY_PASSWORD,
          clientId: `${PENDING_GATEWAY}-POND-02`,
          clean: true,
          connectTimeout: 10_000,
          reconnectPeriod: 0,
        }),
      ).rejects.toThrow();
    });

    it('refuses sensor_service under a client ID that is not its own (ADR-047 §1)', async () => {
      await expect(
        mqtt.connectAsync(`mqtt://${harness!.host}:${harness!.port}`, {
          username: 'sensor_service',
          password: SENSOR_SERVICE_PASSWORD,
          clientId: 'acl-e2e-test',
          clean: true,
          connectTimeout: 10_000,
          reconnectPeriod: 0,
        }),
      ).rejects.toThrow();
    });

    describe("a sensor's own principal (ADR-047)", () => {
      let sensor: mqtt.MqttClient | undefined;
      const received: Array<{ topic: string; payload: string }> = [];

      beforeAll(async () => {
        await subscribeGrants(client!, [SENSOR_MQTT_DATA_FILTER]);
        client!.on('message', (topic, payload) => {
          if (topic.includes('/sensors/')) {
            received.push({ topic, payload: payload.toString('utf8') });
          }
        });
        sensor = await mqtt.connectAsync(`mqtt://${harness!.host}:${harness!.port}`, {
          username: SENSOR_USERNAME,
          password: SENSOR_SECRET,
          clientId: SENSOR_USERNAME,
          clean: true,
          connectTimeout: 10_000,
          reconnectPeriod: 0,
        });
      });

      afterAll(async () => {
        await sensor?.endAsync().catch(() => undefined);
      });

      async function settle(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }

      it('connects under its username as client ID, and under no other', async () => {
        expect(sensor?.connected).toBe(true);
        await expect(
          mqtt.connectAsync(`mqtt://${harness!.host}:${harness!.port}`, {
            username: SENSOR_USERNAME,
            password: SENSOR_SECRET,
            clientId: `${SENSOR_USERNAME}-2`,
            clean: true,
            connectTimeout: 10_000,
            reconnectPeriod: 0,
          }),
        ).rejects.toThrow();
        await expect(
          mqtt.connectAsync(`mqtt://${harness!.host}:${harness!.port}`, {
            username: SENSOR_USERNAME,
            password: 'not-the-secret',
            clientId: SENSOR_USERNAME,
            clean: true,
            connectTimeout: 10_000,
            reconnectPeriod: 0,
          }),
        ).rejects.toThrow();
      });

      it('publishes to its own data topic, which the listener filter receives', async () => {
        await sensor!.publishAsync(SENSOR_TOPIC, JSON.stringify({ ph: 7.1 }), { qos: 1 });
        await settle();
        expect(received).toContainEqual({ topic: SENSOR_TOPIC, payload: '{"ph":7.1}' });
      });

      it("cannot publish to another sensor's topic, nor subscribe to anything", async () => {
        received.length = 0;
        await sensor!.publishAsync(OTHER_SENSOR_TOPIC, JSON.stringify({ ph: 1 }), { qos: 1 });
        await settle();
        expect(received).toEqual([]);
        await expect(subscribeGrants(sensor!, [SENSOR_TOPIC])).rejects.toThrow();
      });

      it("is the only publisher of its topic: sensor_service's PUBLISH there is dropped", async () => {
        received.length = 0;
        await client!.publishAsync(SENSOR_TOPIC, JSON.stringify({ ph: 2 }), { qos: 1 });
        await settle();
        expect(received).toEqual([]);
      });
    });

    it('delivers a published sensor message through sensors/# end-to-end', async () => {
      const received = new Promise<string>((resolve) => {
        client!.on('message', (_topic, payload) => resolve(payload.toString('utf8')));
      });
      await client!.publishAsync('sensors/e2e/probe', JSON.stringify({ temperature: 21.5 }), {
        qos: 1,
      });
      await expect(received).resolves.toContain('"temperature":21.5');
    });
  },
);
