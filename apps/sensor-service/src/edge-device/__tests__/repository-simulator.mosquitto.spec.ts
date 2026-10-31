import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import mqtt from 'mqtt';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { parse as parseYaml } from 'yaml';

import { validateSensorDataPayload } from '@platform/event-contracts';
import { bootMosquittoContainer, type MqttHarness } from '@platform/mqtt-test-harness';

import {
  BROKER_AUTH_SECRET,
  LISTENER_CLIENT_ID,
  SENSOR_SERVICE_PASSWORD,
  platformBrokerAuth,
  startAuthBackend,
  type IssuedSensorPrincipal,
} from '../../__tests__/support/platform-broker-auth.harness';
import { newSensorMqttUsername } from '../../mqtt-identity/sensor-mqtt-secret';
import {
  SENSOR_MQTT_DATA_FILTER,
  sensorMqttDataTopic,
} from '../../mqtt-identity/sensor-mqtt-topic';

/**
 * SENSOR-HIGH-207, the repository simulator: its Node-RED flows, booted as
 * docker-compose.simulators.yml boots them, publish each sensor on that
 * sensor's own issued principal through the platform broker (real Mosquitto,
 * real go-auth, the real MqttAuthService decision path), and the listener's
 * own filter receives every sensor's messages in a shape ingestion accepts.
 *
 * This is the check the static invariant
 * (tests/invariants/repository-sensor-simulator.spec.ts) cannot make: that
 * Node-RED resolves the ${SIM_*} references in the broker nodes' client IDs
 * and credentials and in the output topics, so the credential a developer
 * puts in the environment is the one the broker sees.
 *
 * Gated with the other real-broker suite behind MQTT_ACL_E2E=1 (Docker); CI
 * runs both through `sensor-service:test:broker`.
 */

const RUN = process.env['MQTT_ACL_E2E'] === '1';
const REPO_ROOT = resolve(__dirname, '../../../../..');
const SIMULATOR = join(REPO_ROOT, 'infrastructure/simulators');
const TENANT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

interface ComposeNodeRed {
  readonly image: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** The Node-RED service as the simulator compose file declares it (single source). */
function composeNodeRed(): ComposeNodeRed {
  const compose = parseYaml(
    readFileSync(join(SIMULATOR, 'docker-compose.simulators.yml'), 'utf-8'),
  ) as { services: { nodered: ComposeNodeRed } };
  return compose.services.nodered;
}

/** The sensors the flows publish: SIM_<SENSOR>_MQTT_USERNAME in the compose environment. */
function simulatedSensors(environment: Readonly<Record<string, string>>): string[] {
  return Object.keys(environment).flatMap((name) => {
    const match = /^SIM_([A-Z_]+)_MQTT_USERNAME$/.exec(name);
    return match?.[1] ? [match[1]] : [];
  });
}

/**
 * A writable copy of the Node-RED data directory: Node-RED writes its
 * runtime files into /data, which must not be the repository's, and runs as
 * an unprivileged user.
 */
function nodeRedDataCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nodered-sim-'));
  cpSync(join(SIMULATOR, 'nodered/data'), dir, { recursive: true });
  const open = (path: string): void => {
    chmodSync(path, statSync(path).isDirectory() ? 0o777 : 0o666);
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) open(join(path, entry));
    }
  };
  open(dir);
  return dir;
}

(RUN ? describe : describe.skip)(
  'the repository simulator on the platform broker (SENSOR-HIGH-207)',
  () => {
    jest.setTimeout(300_000);

    const nodered = composeNodeRed();
    const sensors = simulatedSensors(nodered.environment).map((key) => {
      const username = newSensorMqttUsername();
      const sensorId = randomUUID();
      const issued: IssuedSensorPrincipal = {
        principal: {
          username,
          tenantId: TENANT,
          sensorId,
          secret: { hmac: 'unused', kid: 'unused' },
        },
        secret: randomBytes(32).toString('base64url'),
      };
      return { key, issued, topic: sensorMqttDataTopic(TENANT, sensorId) };
    });

    let network: StartedNetwork | undefined;
    let backend: { server: Server; port: number } | undefined;
    let harness: MqttHarness | undefined;
    let simulator: StartedTestContainer | undefined;
    let listener: mqtt.MqttClient | undefined;
    let dataDir: string | undefined;
    const received: Array<{ topic: string; payload: string; retain: boolean }> = [];

    beforeAll(async () => {
      network = await new Network().start();
      backend = await startAuthBackend(
        platformBrokerAuth({ sensors: sensors.map((s) => s.issued) }),
      );
      harness = await bootMosquittoContainer({
        authBackendPort: backend.port,
        authSecret: BROKER_AUTH_SECRET,
        network,
        // The broker nodes in flows.json name the compose service.
        networkAliases: ['mosquitto'],
        startTimeoutMs: 120_000,
      });

      listener = await mqtt.connectAsync(`mqtt://${harness.host}:${harness.port}`, {
        username: 'sensor_service',
        password: SENSOR_SERVICE_PASSWORD,
        clientId: LISTENER_CLIENT_ID,
        clean: true,
        connectTimeout: 10_000,
      });
      listener.on('message', (topic, payload, packet) => {
        received.push({ topic, payload: payload.toString('utf8'), retain: packet.retain });
      });
      // The listener's own filter, and the legacy namespace the simulator left.
      await listener.subscribeAsync([SENSOR_MQTT_DATA_FILTER, 'sensors/#'], { qos: 1 });

      const environment: Record<string, string> = { TZ: 'UTC' };
      for (const { key, issued, topic } of sensors) {
        environment[`SIM_${key}_MQTT_USERNAME`] = issued.principal.username;
        environment[`SIM_${key}_MQTT_PASSWORD`] = issued.secret;
        environment[`SIM_${key}_MQTT_TOPIC`] = topic;
      }
      dataDir = nodeRedDataCopy();
      simulator = await new GenericContainer(nodered.image)
        .withNetwork(network)
        .withEnvironment(environment)
        .withBindMounts([
          { source: dataDir, target: '/data', mode: 'rw' },
          { source: join(dataDir, 'settings.js'), target: '/data/settings.js', mode: 'ro' },
        ])
        .withWaitStrategy(Wait.forLogMessage(/Started flows/).withStartupTimeout(120_000))
        .start();
    });

    afterAll(async () => {
      await listener?.endAsync().catch(() => undefined);
      await simulator?.stop({ remove: true, timeout: 10_000 });
      await harness?.stop();
      await network?.stop();
      backend?.server.close();
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    });

    async function firstMessageOn(topic: string): Promise<{ payload: string; retain: boolean }> {
      for (let waited = 0; waited < 60_000; waited += 500) {
        const message = received.find((m) => m.topic === topic);
        if (message) return message;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(
        `no message on ${topic}; broker log:\n${harness?.capturedLogs().slice(-30).join('\n')}`,
      );
    }

    it('publishes three sensors, each under its own issued principal', () => {
      expect(sensors.map((s) => s.key).sort()).toEqual([
        'FLOW',
        'TEMPERATURE_PROFILE',
        'WATER_QUALITY',
      ]);
    });

    it("delivers every sensor's messages to the listener's filter, not retained, in a shape ingestion accepts", async () => {
      for (const { topic } of sensors) {
        const message = await firstMessageOn(topic);
        const payload: unknown = JSON.parse(message.payload);
        expect({
          topic,
          retain: message.retain,
          valid: validateSensorDataPayload(payload),
        }).toEqual({
          topic,
          retain: false,
          valid: true,
        });
      }
    });

    it("publishes nothing outside its sensors' own topics", () => {
      const own = new Set(sensors.map((s) => s.topic));
      expect(received.filter((m) => !own.has(m.topic)).map((m) => m.topic)).toEqual([]);
    });
  },
);
