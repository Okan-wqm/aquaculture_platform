import { createServer, type Server } from 'node:http';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { ConfigService } from '@nestjs/config';
import { collaborator } from '@aquaculture/testing';

import { DeviceDirectoryService } from '../../edge-device/device-directory.service';
import type { EdgeDevice } from '../../edge-device/entities/edge-device.entity';
import { MqttAuthService } from '../../edge-device/mqtt-auth.service';
import { SensorMqttBrokerAccess } from '../../mqtt-identity/sensor-mqtt-broker-access.service';
import type {
  SensorMqttIdentityService,
  SensorMqttPrincipal,
} from '../../mqtt-identity/sensor-mqtt-identity.service';

/**
 * The sensor-service side of a real-broker test: MqttAuthService deciding as
 * in production, behind a stand-in for MqttAuthController's three go-auth
 * endpoints, which the broker the mqtt-test-harness boots calls over HTTP.
 * Shared by the *.mosquitto.spec.ts suites so each proves its own claim
 * against one decision path.
 */

/** Value of X-Mosquitto-Auth the harness renders into the broker config. */
export const BROKER_AUTH_SECRET = 'test-mosquitto-auth-secret';
export const SENSOR_SERVICE_PASSWORD = 'test-sensor-service-password';
/** sensor_service's listener connects as MQTT_CLIENT_ID + '-main'. */
export const LISTENER_CLIENT_ID = 'aqua-sensor-service-main';

/** A Mosquitto $7$ hash at file-mode cost, cheap enough for a test. */
export function mosquittoHash(password: string): string {
  const salt = randomBytes(12);
  const derivedKey = pbkdf2Sync(password, salt, 101, 24, 'sha512');
  return `$7$101$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

/** A sensor's issued principal and the secret its device presents. */
export interface IssuedSensorPrincipal {
  readonly principal: SensorMqttPrincipal;
  readonly secret: string;
}

/**
 * MqttAuthService in production mode for the given edge gateways (by MQTT
 * client ID) and sensor principals. The device directory and the sensor
 * principal lookup stand in for the database reads; MqttAuthService and
 * SensorMqttBrokerAccess decide as in production.
 */
export function platformBrokerAuth(options: {
  readonly gateways?: readonly EdgeDevice[];
  readonly sensors?: readonly IssuedSensorPrincipal[];
}): MqttAuthService {
  const cfg = new ConfigService({
    NODE_ENV: 'production',
    MQTT_AUTH_MODE: 'http',
    MQTT_SENSOR_SERVICE_HASH: mosquittoHash(SENSOR_SERVICE_PASSWORD),
    MQTT_AUTH_SECRET: BROKER_AUTH_SECRET,
    MQTT_CLIENT_ID: 'aqua-sensor-service',
  });
  const gateways = new Map((options.gateways ?? []).map((device) => [device.mqttClientId, device]));
  const directory = collaborator<DeviceDirectoryService>(
    { findDevice: jest.fn(async (_column: string, value: string) => gateways.get(value) ?? null) },
    'DeviceDirectoryService',
  );
  const sensors = new Map(
    (options.sensors ?? []).map((issued) => [issued.principal.username, issued]),
  );
  const identity = collaborator<SensorMqttIdentityService>(
    {
      findPrincipal: jest.fn(async (username: string) => sensors.get(username)?.principal ?? null),
      verifySecret: jest.fn(
        (principal: SensorMqttPrincipal, presented: string) =>
          sensors.get(principal.username)?.secret === presented,
      ),
    },
    'SensorMqttIdentityService',
  );
  return new MqttAuthService(cfg, directory, new SensorMqttBrokerAccess(identity));
}

/** Minimal stand-in for MqttAuthController's three go-auth endpoints. */
export function startAuthBackend(
  service: MqttAuthService,
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      const allowed = (ok: boolean): void => {
        res.writeHead(ok ? 200 : 403);
        res.end(ok ? 'ok' : 'Denied');
      };
      try {
        // Controller semantics (validateMosquittoSecret): a PRESENT header
        // must match; an absent header is tolerated. go-auth 3.0.0 parses no
        // header option at all, so absence is the production path
        // (SENSOR-MEDIUM-174).
        const header = req.headers['x-mosquitto-auth'];
        if (typeof header === 'string' && header !== BROKER_AUTH_SECRET) {
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
