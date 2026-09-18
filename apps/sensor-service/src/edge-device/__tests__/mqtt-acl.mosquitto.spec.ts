import { createServer, type Server } from 'node:http';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';

import { ConfigService } from '@nestjs/config';
import type { DataSource, Repository } from 'typeorm';
import mqtt from 'mqtt';
import { collaborator, stubMember } from '@aquaculture/testing';

import { bootMosquittoContainer, type MqttHarness } from '@platform/mqtt-test-harness';

import { DeviceDirectoryService } from '../device-directory.service';
import { EdgeDevice } from '../entities/edge-device.entity';
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

function mosquittoHash(password: string): string {
  const salt = randomBytes(12);
  const derivedKey = pbkdf2Sync(password, salt, 101, 24, 'sha512');
  return `$7$101$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

function makeAuthService(): MqttAuthService {
  const repo = collaborator<Repository<EdgeDevice>>(
    {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
    },
    'Repository<EdgeDevice>',
  );
  const ds = collaborator<DataSource>(
    { query: stubMember<DataSource['query']>(jest.fn().mockResolvedValue([])) },
    'DataSource',
  );
  const cfg = new ConfigService({
    NODE_ENV: 'production',
    MQTT_AUTH_MODE: 'http',
    MQTT_SENSOR_SERVICE_HASH: mosquittoHash(SENSOR_SERVICE_PASSWORD),
    MQTT_AUTH_SECRET: SECRET,
  });
  const directory = {
    lookupTenantId: jest.fn().mockResolvedValue(null),
    backfill: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const directoryCollaborator = collaborator<DeviceDirectoryService>(
    directory,
    'DeviceDirectoryService',
  );
  return new MqttAuthService(cfg, repo, ds, directoryCollaborator);
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
        // must match; an absent header is tolerated. go-auth 3.0.0 does not
        // forward auth_opt_http_headers on the auth call, so absence is the
        // normal production path too.
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
