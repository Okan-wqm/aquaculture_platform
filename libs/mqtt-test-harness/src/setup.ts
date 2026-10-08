import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

/**
 * MQTT broker test harness — a real Mosquitto + mosquitto-go-auth container
 * whose auth/acl decisions delegate over HTTP to a sensor-service
 * MqttAuthController under test.
 *
 * Canonical pattern from `docs/patterns/jest-testcontainers.md` (same model
 * as `@platform/migration-harness`): one shared container per spec file,
 * boot in `beforeAll`, `stop()` in `afterAll`.
 *
 * # Why a real broker at all
 *
 * The SENSOR-HIGH-118 class of bug lives BETWEEN three components: the
 * listener's filter list, the go-auth HTTP bridge semantics (acc=4 =
 * MOSQ_ACL_SUBSCRIBE on wildcard filters), and the broker's SUBACK handling
 * (0x80 for a denied filter). Mock-based unit tests proved each component in
 * isolation and still shipped a listener subscribed to NOTHING. Only a real
 * Mosquitto exercising the real go-auth plugin against the real
 * `checkTopicAccess` decision path reproduces that contract.
 *
 * # Image
 *
 * Default image is the platform's own hardened broker
 * (`ghcr.io/okan-wqm/aquaculture_platform/mosquitto` — mosquitto + go-auth
 * .so, no TLS listener; production terminates TLS at nginx). Override via
 * `image` or MQTT_TEST_BROKER_IMAGE.
 *
 * # Config
 *
 * The broker config IS infrastructure/mosquitto/mosquitto-production.conf —
 * read at boot, not copied — with only the auth endpoint (host, port) and the
 * __MQTT_AUTH_SECRET__ placeholder substituted, so the plugin settings under
 * test (cache, params mode, response mode) are production's by construction.
 * A copied config had drifted: it ran `auth_opt_cache false` while production
 * cached auth decisions for 5 s, keyed without the client ID. The rendered
 * file is bind-mounted over /mosquitto/config/mosquitto.conf and the broker
 * runs the same command the image declares.
 */

export interface MqttHarnessOptions {
  /** Broker image; defaults to the platform mosquitto (go-auth baked in). */
  image?: string;
  /**
   * Hostname the broker resolves for the auth HTTP calls. Defaults to
   * `sensor-service` pinned to the Docker host gateway, so an HTTP server
   * in the jest process (listen on 0.0.0.0) is reachable.
   */
  authBackendHost?: string;
  authBackendHostIp?: string;
  /** Port the auth endpoints listen on (the jest process's server). */
  authBackendPort: number;
  /** Value the broker sends as X-Mosquitto-Auth (must match the backend). */
  authSecret: string;
  startTimeoutMs?: number;
}

export interface MqttHarness {
  container: StartedTestContainer;
  /** Host to connect an MQTT client to. */
  host: string;
  port: number;
  /** Broker log lines captured since boot (for failure diagnostics). */
  capturedLogs(): string[];
  stop(): Promise<void>;
}

const PLATFORM_MOSQUITTO_IMAGE =
  'ghcr.io/okan-wqm/aquaculture_platform/mosquitto:9b44390f98e16c4de759bfbc4d524e4312d2a81b';

/** The production broker config the harness boots from (single source). */
export const PRODUCTION_BROKER_CONFIG = resolve(
  __dirname,
  '../../../infrastructure/mosquitto/mosquitto-production.conf',
);

/**
 * Substitute one production setting. Throws when the production file no
 * longer carries the line, so a reshaped config fails the harness loudly
 * instead of silently booting against the wrong endpoint.
 */
function substitute(conf: string, pattern: RegExp, replacement: string): string {
  if (!pattern.test(conf)) {
    throw new Error(
      `mqtt-test-harness: ${PRODUCTION_BROKER_CONFIG} no longer matches ${pattern.source}`,
    );
  }
  return conf.replace(pattern, replacement);
}

/** Production config with the auth endpoint and shared secret pinned to this run. */
export function renderBrokerConfig(
  production: string,
  endpoint: { host: string; port: number; secret: string },
): string {
  let conf = substitute(
    production,
    /^auth_opt_http_host .*$/m,
    `auth_opt_http_host ${endpoint.host}`,
  );
  conf = substitute(conf, /^auth_opt_http_port .*$/m, `auth_opt_http_port ${endpoint.port}`);
  return substitute(conf, /__MQTT_AUTH_SECRET__/g, endpoint.secret);
}

function writeBrokerConfig(options: MqttHarnessOptions): string {
  const conf = renderBrokerConfig(readFileSync(PRODUCTION_BROKER_CONFIG, 'utf8'), {
    host: options.authBackendHost ?? 'sensor-service',
    port: options.authBackendPort,
    secret: options.authSecret,
  });
  const dir = mkdtempSync(join(tmpdir(), 'mqtt-acl-test-'));
  const file = join(dir, 'mosquitto.conf');
  writeFileSync(file, conf, { encoding: 'utf8' });
  return file;
}

export async function bootMosquittoContainer(options: MqttHarnessOptions): Promise<MqttHarness> {
  const image = options.image ?? process.env['MQTT_TEST_BROKER_IMAGE'] ?? PLATFORM_MOSQUITTO_IMAGE;
  const confFile = writeBrokerConfig(options);
  const backendHostIp = options.authBackendHostIp ?? 'host-gateway';

  try {
    const container = new GenericContainer(image)
      .withBindMounts([
        { source: confFile, target: '/mosquitto/config/mosquitto.conf', mode: 'ro' },
      ])
      .withCommand(['mosquitto', '-c', '/mosquitto/config/mosquitto.conf'])
      .withExtraHosts([
        { host: options.authBackendHost ?? 'sensor-service', ipAddress: backendHostIp },
      ])
      .withExposedPorts(1883)
      .withWaitStrategy(
        Wait.forSuccessfulCommand('nc -z localhost 1883').withStartupTimeout(
          options.startTimeoutMs ?? 60_000,
        ),
      );

    const logs: string[] = [];
    container.withLogConsumer((stream) => {
      stream.on('data', (line: Buffer | string) => logs.push(String(line).trim()));
    });

    const started = await container.start();

    return {
      container: started,
      host: started.getHost(),
      port: started.getMappedPort(1883),
      capturedLogs: () => [...logs],
      async stop() {
        await started.stop({ remove: true, timeout: 10_000 });
      },
    };
  } finally {
    rmSync(dirname(confFile), { recursive: true, force: true });
  }
}
