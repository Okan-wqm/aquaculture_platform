/**
 * Prometheus scrape-target ↔ service-catalog sync invariant (B2 / D3).
 * ============================================================================
 *
 * SSoT chain:
 *
 *   platform/libs/service-catalog/src/index.ts        → which services exist,
 *                                                        their compose name,
 *                                                        containerPort,
 *                                                        metricsExposure,
 *                                                        criticality
 *   scripts/service-catalog/generate-artifacts.ts     → emits the file_sd
 *   infrastructure/monitoring/droplet/file_sd/         → what Prometheus scrapes
 *   THIS FILE                                          → fails CI on drift
 *
 * ORPHAN-HIGH-090: the droplet runs no collector because nothing generated
 * scrape targets. D3 makes the catalog the SSoT for those targets. A scrape
 * config that drifts from the running service set is the classic silent
 * observability gap — a new backend ships, nobody adds it to a hand-written
 * prometheus.yml, and it is simply never scraped. Deriving the targets from the
 * catalog + gating that derivation here makes the gap structurally impossible:
 * a catalog change that is not regenerated, or a hand-edit of the file_sd,
 * fails this invariant at PR time (the fast shard) rather than as a blind spot
 * discovered during an incident.
 *
 * When this fails: run `npm run service-catalog:generate` and commit the
 * regenerated infrastructure/monitoring/droplet/file_sd/aqua-services.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

// Relative import (not the @platform alias): the invariants jest project has no
// moduleNameMapper for @platform scopes — same convention as the sibling
// metrics-endpoint-adoption.spec.ts.
import { activeDropletServices } from '../../platform/libs/service-catalog/src';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FILE_SD_PATH = path.join(
  REPO_ROOT,
  'infrastructure/monitoring/droplet/file_sd/aqua-services.json',
);
const PROMETHEUS_CONFIG_PATH = path.join(
  REPO_ROOT,
  'infrastructure/monitoring/droplet/prometheus.yml',
);
const MONITORING_COMPOSE_PATH = path.join(REPO_ROOT, 'docker-compose.monitoring.yml');
const APPLICATION_COMPOSE_PATH = path.join(REPO_ROOT, 'docker-compose.droplet.yml');
const MONITORING_UP_PATH = path.join(REPO_ROOT, 'scripts/monitoring/monitoring-up.sh');

interface ComposeFile {
  services?: Record<
    string,
    {
      command?: string[];
      environment?: Record<string, string>;
      networks?: string[];
      ports?: string[];
      volumes?: string[];
    }
  >;
}

function readCompose(filePath: string): ComposeFile {
  return yaml.load(fs.readFileSync(filePath, 'utf8')) as ComposeFile;
}

interface ScrapeTargetGroup {
  targets: string[];
  labels: { app: string; namespace: string; criticality: string };
}

// Re-derive the expected file_sd the SAME way the generator does. This is a
// deliberate, independent re-derivation (a parity check is supposed to compute
// the truth twice from the SSoT and compare) — not a DRY violation.
const expected: ScrapeTargetGroup[] = activeDropletServices()
  .filter((entry) => entry.metricsExposure === 'prom-endpoint')
  .map((entry) => ({
    targets: [`${entry.composeServiceName}:${entry.containerPort}`],
    labels: {
      app: entry.serviceId,
      namespace: 'aquaculture',
      criticality: entry.criticality,
    },
  }));

describe('INVARIANT: Prometheus file_sd scrape targets stay in sync with the service catalog (B2 / D3)', () => {
  it('the committed file_sd exists', () => {
    expect(fs.existsSync(FILE_SD_PATH)).toBe(true);
  });

  const committed = JSON.parse(fs.readFileSync(FILE_SD_PATH, 'utf8')) as ScrapeTargetGroup[];

  it('matches the catalog-derived target set EXACTLY (run `npm run service-catalog:generate` after catalog edits)', () => {
    expect(committed).toEqual(expected);
  });

  it('covers every prom-endpoint droplet service with no silent blind spot', () => {
    expect(committed.length).toBe(expected.length);
    // tripwire: the platform has 14+ scrapeable backends; a collapse to a
    // handful means the catalog filter or compose-name field regressed.
    expect(committed.length).toBeGreaterThanOrEqual(10);
  });

  it('every target is <compose-service>:<port> and carries app + namespace + criticality labels', () => {
    for (const group of committed) {
      expect(group.targets).toHaveLength(1);
      expect(group.targets[0]).toMatch(/^[a-z][a-z0-9-]*:\d+$/);
      expect(group.labels.namespace).toBe('aquaculture');
      expect(group.labels.app).toBeTruthy();
      expect(group.labels.criticality).toBeTruthy();
    }
  });
});

describe('100-tenant monitoring ownership and broker scrape contract', () => {
  const monitoring = readCompose(MONITORING_COMPOSE_PATH);
  const application = readCompose(APPLICATION_COMPOSE_PATH);
  const prometheus = fs.readFileSync(PROMETHEUS_CONFIG_PATH, 'utf8');
  const monitoringUp = fs.readFileSync(MONITORING_UP_PATH, 'utf8');

  it('keeps every monitoring service in the dedicated compose project only', () => {
    const ownedServices = [
      'prometheus',
      'alertmanager',
      'node-exporter',
      'cadvisor',
      'nats-exporter',
      'mosquitto-exporter',
    ];

    for (const serviceName of ownedServices) {
      expect(monitoring.services?.[serviceName]).toBeDefined();
      expect(application.services?.[serviceName]).toBeUndefined();
    }
  });

  it('scrapes NATS 8222 and Mosquitto $SYS through dedicated internal exporters', () => {
    const natsExporter = monitoring.services?.['nats-exporter'];
    const mosquittoExporter = monitoring.services?.['mosquitto-exporter'];

    expect(natsExporter?.command?.join(' ')).toContain('http://nats:8222');
    expect(natsExporter?.command?.join(' ')).toContain('-jsz=all');
    expect(natsExporter?.networks).toContain('aqua-internal');
    expect(natsExporter?.ports).toBeUndefined();

    expect(mosquittoExporter?.environment).toMatchObject({
      MOSQUITTO_BROKER_ENDPOINT: 'tcp://mosquitto:1883',
      MOSQUITTO_USERNAME: 'mqtt_exporter',
    });
    expect(mosquittoExporter?.environment?.MOSQUITTO_PASSWORD).toContain('MQTT_EXPORTER_PASSWORD');
    expect(mosquittoExporter?.networks).toContain('aqua-internal');
    expect(mosquittoExporter?.ports).toBeUndefined();

    expect(prometheus).toContain("targets: ['nats-exporter:7777']");
    expect(prometheus).toContain("targets: ['mosquitto-exporter:9234']");
  });

  it('authenticates the guarded observability scrape with a repo-external credential file', () => {
    const prometheusService = monitoring.services?.prometheus;

    expect(prometheus).toContain("targets: ['observability-service:3009']");
    expect(prometheus).toContain('credentials_file: /run/secrets/observability_internal_api_key');
    expect(prometheus).toMatch(
      /source_labels:\s*\[app\][\s\S]*regex:\s*observability-service[\s\S]*action:\s*drop/,
    );
    expect(prometheusService?.volumes).toContain(
      '${OBSERVABILITY_PROMETHEUS_CREDENTIAL_FILE:?required}:/run/secrets/observability_internal_api_key:ro',
    );
    expect(monitoringUp).toContain('OBSERVABILITY_INTERNAL_API_KEY');
    expect(monitoringUp).toContain('OBSERVABILITY_PROMETHEUS_CREDENTIAL_FILE');
    expect(monitoringUp).not.toContain('docker-compose.droplet.yml');
  });

  it('keeps node-exporter wired to the probe and supervisor textfile directory', () => {
    const nodeExporter = monitoring.services?.['node-exporter'];

    expect(nodeExporter?.command).toContain(
      '--collector.textfile.directory=/var/lib/node_exporter/textfile',
    );
    expect(nodeExporter?.volumes).toContain(
      '/var/lib/node_exporter/textfile:/var/lib/node_exporter/textfile:ro',
    );
  });
});
