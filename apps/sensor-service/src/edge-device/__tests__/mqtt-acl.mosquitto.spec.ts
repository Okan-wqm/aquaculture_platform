import { createServer, type Server } from 'node:http';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';

import { ConfigService } from '@nestjs/config';
import mqtt from 'mqtt';
import { collaborator } from '@aquaculture/testing';

import { bootMosquittoContainer, type MqttHarness } from '@platform/mqtt-test-harness';

import { DeviceDirectoryService } from '../device-directory.service';
import { DeviceLifecycleState, EdgeDevice } from '../entities/edge-device.entity';
import { MqttAuthService } from '../mqtt-auth.service';
import { SENSOR_SERVICE_SUBSCRIPTION_FILTERS } from '../../ingestion/mqtt-listener.service';

/**
 * SENSOR-HIGH-118 end-to-end: real Mosquitto + real go-auth + the real
 * MqttAuthService decision path. This is the only test class that can catch
 * "ACL code says yes but Mosquitto 2.x asks acc=4 on wildcard SUBSCRIBEs and
 * one 0x80 kills the whole batch" — the exact failure that left production
 * subscribed to nothing.
 *
 * Gated behind MQTT_ACL_E2E=1 (same convention as
 * SENSOR_INGEST_EQUIVALENCE_E2E) because it needs Docker and the platform
 * mosquitto image (override with MQTT_TEST_BROKER_IMAGE).
 */

const RUN = process.env['MQTT_ACL_E2E'] === '1';
const SECRET = 'test-mosquitto-auth-secret';
const SENSOR_SERVICE_PASSWORD = 'test-sensor-service-password';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GATEWAY_PASSWORD = 'test-gateway-password';
const ACTIVE_GATEWAY = 'edge-aaaaaaaa-pond-01';
const PENDING_GATEWAY = 'edge-aaaaaaaa-pond-02';

function mosquittoHash(password: string): string {
  const salt = randomBytes(12);
  const derivedKey = pbkdf2Sync(password, salt, 101, 24, 'sha512');
  return `$7$101$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

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

function makeAuthService(): MqttAuthService {
  const cfg = new ConfigService({
    NODE_ENV: 'production',
    MQTT_AUTH_MODE: 'http',
    MQTT_SENSOR_SERVICE_HASH: mosquittoHash(SENSOR_SERVICE_PASSWORD),
    MQTT_AUTH_SECRET: SECRET,
  });
  const gateways = new Map<string, EdgeDevice>([
    [ACTIVE_GATEWAY, gateway(ACTIVE_GATEWAY, DeviceLifecycleState.ACTIVE)],
    [PENDING_GATEWAY, gateway(PENDING_GATEWAY, DeviceLifecycleState.PENDING_APPROVAL)],
  ]);
  const directory = {
    findDevice: jest.fn(async (_column: string, value: string) => gateways.get(value) ?? null),
  };
  const directoryCollaborator = collaborator<DeviceDirectoryService>(
    directory,
    'DeviceDirectoryService',
  );
  return new MqttAuthService(cfg, directoryCollaborator);
}

/** Minimal stand-in for MqttAuthController's three go-auth endpoints. */
function startAuthBackend(service: MqttAuthService): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      const allowed = (ok: boolean) => {
        res.writeHead(ok ? 200 : 403);
        res.end(ok ? 'ok' : 'Denied');
      };
      try {
        // Controller semantics (validateMosquittoSecret): a PRESENT header
        // must match; an absent header is tolerated. go-auth 3.0.0 parses no
        // header option at all, so absence is the production path
        // (SENSOR-MEDIUM-174).
        const header = req.headers['x-mosquitto-auth'];
        if (typeof header === 'string' && header !== SECRET) {
          res.writeHead(403);
          res.end('Denied');
          return;
        }
        if (req.url === '/mqtt/auth') {
          allowed(
            await service.verifyDeviceCredentials(
              String(body.username ?? ''),
              String(body.password ?? ''),
              typeof body.clientid === 'string' ? body.clientid : undefined,
            ),
          );
        } else if (req.url === '/mqtt/superuser') {
          allowed(service.isSuperuser(String(body.username ?? '')));
        } else if (req.url === '/mqtt/acl') {
          allowed(
            await service.checkTopicAccess(
              String(body.username ?? ''),
              String(body.topic ?? ''),
              Number(body.acc ?? 0),
            ),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch {
        // Auth backend failures are denials by contract (go-auth treats
        // non-200 as deny) — same shape as MqttAuthController's exception map.
        res.writeHead(403);
        res.end('Denied');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
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
      const service = makeAuthService();
      backend = await startAuthBackend(service);
      harness = await bootMosquittoContainer({
        authBackendPort: backend.port,
        authSecret: SECRET,
        startTimeoutMs: 120_000,
      });

      client = await mqtt.connectAsync(`mqtt://${harness.host}:${harness.port}`, {
        username: 'sensor_service',
        password: SENSOR_SERVICE_PASSWORD,
        clientId: 'acl-e2e-test',
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
