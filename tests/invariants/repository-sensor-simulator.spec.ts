/**
 * INVARIANT: the repository sensor simulator speaks the platform broker's
 * device contract (ADR-047, sensorprotocols/mqtt-protocol.md) and holds no
 * service account.
 *
 * SENSOR-HIGH-207: the simulator published three sensors' readings as
 * `sensor_service`, the account that reads and writes every tenant's sensor,
 * device and command topics, to a broker of its own that authenticated from a
 * password file, so no issued principal could reach it. It now runs the
 * platform broker and publishes each sensor on that sensor's own issued
 * principal. This suite keeps it there: every broker node is one sensor
 * principal read from the environment, every output is that sensor's own
 * topic at QoS 1 and never retained, nothing subscribes, the compose file
 * hands Node-RED exactly the variables the flows read and runs the platform
 * broker image, and every message a generator builds passes the ingestion
 * schema with numbers for its channels.
 *
 * The live counterpart, repository-simulator.mosquitto.spec.ts, boots these
 * flows in Node-RED against the real broker.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import yaml from 'js-yaml';

import { LEGACY_SENSOR_SERVICE_PUBLISHERS } from '../../apps/sensor-service/src/mqtt-identity/legacy-mqtt-publishers';
import {
  SENSOR_DATA_PAYLOAD_MAX_BYTES,
  SENSOR_DATA_TIMESTAMP_PATTERN,
  validateSensorDataPayload,
} from '../../libs/event-contracts/src/schemas/sensor-data-payload.schema';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SIMULATOR = 'infrastructure/simulators';
const DATA = `${SIMULATOR}/nodered/data`;
const COMPOSE = `${SIMULATOR}/docker-compose.simulators.yml`;
const SERVICE_ACCOUNTS = ['sensor_service', 'backend_service', 'alert_service'] as const;
/** The device contract's keepalive bound (sensorprotocols/mqtt-protocol.md). */
const MAX_KEEPALIVE_SECONDS = 300;
/** The broker admits one message a second per sensor (ADR-047 rate cap). */
const MIN_PUBLISH_INTERVAL_SECONDS = 1;

interface FlowNode {
  readonly id: string;
  readonly type: string;
  readonly z?: string;
  readonly wires?: readonly (readonly string[])[];
  readonly [property: string]: unknown;
}

interface BrokerCredentials {
  readonly user?: unknown;
  readonly password?: unknown;
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

const flows = JSON.parse(readRepoFile(`${DATA}/flows.json`)) as readonly FlowNode[];
const credentials = JSON.parse(readRepoFile(`${DATA}/flows_cred.json`)) as Readonly<
  Record<string, BrokerCredentials>
>;
const ofType = (type: string): readonly FlowNode[] => flows.filter((node) => node.type === type);
const byId = new Map(flows.map((node) => [node.id, node]));

/** `${SIM_<SENSOR>_MQTT_<PART>}` → the sensor key, or null for anything else. */
function sensorOf(value: unknown, part: 'USERNAME' | 'PASSWORD' | 'TOPIC'): string | null {
  const match =
    typeof value === 'string' ? /^\$\{SIM_([A-Z_]+)_MQTT_([A-Z]+)\}$/.exec(value) : null;
  return match && match[2] === part ? (match[1] ?? null) : null;
}

const brokers = ofType('mqtt-broker');
const outputs = ofType('mqtt out');

describe('INVARIANT: the repository sensor simulator publishes each sensor on its own principal', () => {
  it('keeps one flow source: flows.json and its flows_cred.json', () => {
    const tracked = execFileSync('git', ['ls-files', '--', `${SIMULATOR}/nodered`], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    })
      .split('\n')
      .filter((path) => /flow/i.test(path));
    expect(tracked.sort()).toEqual([`${DATA}/flows.json`, `${DATA}/flows_cred.json`]);
    // Plain JSON (credentialSecret false): an encrypted file is one "$" blob.
    expect(Object.keys(credentials)).not.toContain('$');
  });

  it('connects every broker node as one sensor principal named by the environment', () => {
    expect(brokers.length).toBeGreaterThan(0);
    const sensors = brokers.map((broker) => {
      const sensor = sensorOf(broker['clientid'], 'USERNAME');
      expect({ broker: broker.id, sensor }).toEqual({
        broker: broker.id,
        sensor: expect.any(String),
      });
      // The client ID is the username (the broker refuses any other).
      expect(sensorOf(credentials[broker.id]?.user, 'USERNAME')).toBe(sensor);
      expect(sensorOf(credentials[broker.id]?.password, 'PASSWORD')).toBe(sensor);
      expect({
        broker: broker['broker'],
        port: broker['port'],
        usetls: broker['usetls'],
        protocolVersion: ['4', '5'].includes(String(broker['protocolVersion'])),
        keepalive: Number(broker['keepalive']) <= MAX_KEEPALIVE_SECONDS,
        will: broker['willTopic'] ?? '',
        birth: broker['birthTopic'] ?? '',
        close: broker['closeTopic'] ?? '',
      }).toEqual({
        broker: 'mosquitto',
        port: '1883',
        usetls: false,
        protocolVersion: true,
        keepalive: true,
        will: '',
        birth: '',
        close: '',
      });
      return sensor;
    });
    expect(new Set(sensors).size).toBe(sensors.length);
  });

  it("publishes each output to its own broker's sensor topic at QoS 1, never retained", () => {
    for (const output of outputs) {
      const broker = byId.get(String(output['broker']));
      expect({ output: output.id, type: broker?.type }).toEqual({
        output: output.id,
        type: 'mqtt-broker',
      });
      expect({
        output: output.id,
        topic: sensorOf(output['topic'], 'TOPIC'),
        qos: output['qos'],
        retain: output['retain'],
      }).toEqual({
        output: output.id,
        topic: sensorOf(broker?.['clientid'], 'USERNAME'),
        qos: '1',
        retain: 'false',
      });
    }
    expect(new Set(outputs.map((output) => output['broker']))).toEqual(
      new Set(brokers.map((broker) => broker.id)),
    );
  });

  it('subscribes to nothing: a sensor principal may publish to its own topic only', () => {
    expect(ofType('mqtt in').map((node) => node.id)).toEqual([]);
  });

  it('names no service account and no legacy publisher anywhere', () => {
    const text = JSON.stringify([flows, credentials]);
    for (const name of [
      ...SERVICE_ACCOUNTS,
      ...LEGACY_SENSOR_SERVICE_PUBLISHERS,
      'nodered-simulator',
    ]) {
      expect({ name, found: text.includes(name) }).toEqual({ name, found: false });
    }
  });

  it('builds messages the ingestion schema accepts, with a number for every channel', () => {
    const generators = flows.filter(
      (node) =>
        node.type === 'function' &&
        (node.wires ?? []).flat().some((target) => byId.get(target)?.type === 'mqtt out'),
    );
    expect(generators).toHaveLength(outputs.length);
    for (const generator of generators) {
      const sandbox: { msg: { payload?: unknown } } = { msg: {} };
      runInNewContext(`(function () { ${String(generator['func'])} })()`, sandbox);
      const payload = sandbox.msg.payload;
      const wire = JSON.stringify(payload);

      expect({ generator: generator.id, valid: validateSensorDataPayload(payload) }).toEqual({
        generator: generator.id,
        valid: true,
      });
      expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(SENSOR_DATA_PAYLOAD_MAX_BYTES);

      const { timestamp, ...channels } = JSON.parse(wire) as Record<string, unknown>;
      expect(String(timestamp)).toMatch(SENSOR_DATA_TIMESTAMP_PATTERN);
      const leaves = (value: unknown): unknown[] =>
        typeof value === 'object' && value !== null
          ? Object.values(value).flatMap(leaves)
          : [value];
      const values = leaves(channels);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect({ generator: generator.id, value, number: Number.isFinite(value) }).toEqual({
          generator: generator.id,
          value,
          number: true,
        });
      }
    }
  });

  it('publishes no sensor faster than the broker admits', () => {
    for (const inject of ofType('inject')) {
      expect(Number(inject['repeat'])).toBeGreaterThanOrEqual(MIN_PUBLISH_INTERVAL_SECONDS);
    }
  });

  it('keeps credentials as environment references: nothing to encrypt, so no credential secret', () => {
    const sandbox: { module: { exports: Record<string, unknown> }; process: { env: object } } = {
      module: { exports: {} },
      process: { env: {} },
    };
    runInNewContext(readRepoFile(`${DATA}/settings.js`), sandbox);
    expect(sandbox.module.exports['credentialSecret']).toBe(false);
  });
});

describe('INVARIANT: the simulator compose runs the platform broker and passes the flows their variables', () => {
  interface ComposeService {
    readonly build?: { readonly context?: string };
    readonly ports?: readonly string[];
    readonly volumes?: readonly string[];
    readonly environment?: Readonly<Record<string, string>>;
  }
  const compose = yaml.load(readRepoFile(COMPOSE)) as {
    services: Readonly<Record<string, ComposeService>>;
  };
  const broker = compose.services['mosquitto'];
  const nodered = compose.services['nodered'];

  it('builds the platform broker image and keeps its production config', () => {
    expect(resolve(REPO_ROOT, SIMULATOR, broker?.build?.context ?? '')).toBe(
      resolve(REPO_ROOT, 'infrastructure/mosquitto'),
    );
    // No mount over the image's config: it runs mosquitto-production.conf.
    expect(
      (broker?.volumes ?? []).filter((volume) => volume.includes('/mosquitto/config')),
    ).toEqual([]);
  });

  it('publishes the broker and the editor on this machine only', () => {
    for (const port of [...(broker?.ports ?? []), ...(nodered?.ports ?? [])]) {
      expect(port.startsWith('127.0.0.1:')).toBe(true);
    }
  });

  it('hands Node-RED exactly the variables the flows read, from the environment', () => {
    const read = new Set<string>();
    for (const broker of brokers) {
      const sensor = sensorOf(broker['clientid'], 'USERNAME');
      for (const part of ['USERNAME', 'PASSWORD', 'TOPIC']) {
        read.add(`SIM_${String(sensor)}_MQTT_${part}`);
      }
    }
    const environment = nodered?.environment ?? {};
    const handed = Object.keys(environment).filter((name) => name.startsWith('SIM_'));
    expect(new Set(handed)).toEqual(read);
    for (const name of handed) {
      expect(environment[name]).toBe(`\${${name}:-}`);
    }
  });
});
