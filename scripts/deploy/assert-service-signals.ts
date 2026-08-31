#!/usr/bin/env node
/**
 * WS7 / ADR-016 Phase F — boot signal assertion.
 *
 * Scrapes current-deploy `docker compose logs` for each service declared in
 * `infrastructure/deploy/required-signals.yaml` and fails the deploy if any
 * required structured boot signal is missing within the per-service SLA.
 *
 * Tier-1 Make-Impossible: deploy succeeds iff every declared service
 * emitted every declared signal. A missing signal means the service
 * started but a boot-time invariant (NATS auth, schema drift check,
 * migration runner) was skipped — that always indicates a regression
 * and must block the deploy, not be discovered via alerting later.
 *
 * Runs on the droplet via SSH; uses Node 22's built-in TypeScript
 * type-stripping (no transpile step). Pulls js-yaml from the repo's
 * node_modules, which the deploy workflow installs before this step.
 *
 * Environment:
 *   COMPOSE_FILE       compose file (default: docker-compose.droplet.yml)
 *   MANIFEST           override manifest path
 *   POLL_INTERVAL      seconds between polling rounds (default: 10)
 *   BOOT_SIGNAL_SINCE  optional docker logs --since value. When absent, the
 *                      asserter uses each container's StartedAt timestamp.
 *   FULL_DEPLOY        "true" asserts every manifest service. Otherwise
 *                      asserts DEPLOY_SERVICES and, when RUN_DB_MIGRATE is
 *                      not false, db-migrate.
 *   DEPLOY_SERVICES    comma/space-separated restarted services for selective
 *                      deploys.
 *   RUN_DB_MIGRATE     "false" excludes db-migrate from selective assertions.
 *   ALLOW_LEGACY_BOOT_SIGNAL_SUBSTRING
 *                      opt-in transition mode for substring matching.
 *
 * Exit codes:
 *   0  every required signal present for every declared service
 *   1  at least one signal missing within window
 *   2  invocation error
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const COMPOSE_FILE = process.env['COMPOSE_FILE'] ?? 'docker-compose.droplet.yml';
const MANIFEST_PATH = process.env['MANIFEST'] ?? 'infrastructure/deploy/required-signals.yaml';
const POLL_INTERVAL = Number.parseInt(process.env['POLL_INTERVAL'] ?? '10', 10);
const BOOT_SIGNAL_SINCE = process.env['BOOT_SIGNAL_SINCE'];
const ALLOW_LEGACY_SUBSTRING = process.env['ALLOW_LEGACY_BOOT_SIGNAL_SUBSTRING'] === 'true';

interface SignalDef {
  pattern: string;
  description?: string;
  canonicalSource?: string;
  emitterSources?: string[];
  signalSource?: string;
}

interface ServiceReq {
  name: string;
  signals: string[];
  window_seconds?: number;
}

interface Manifest {
  schema_version?: number;
  defaults?: { window_seconds?: number };
  signal_library?: Record<string, SignalDef>;
  services?: ServiceReq[];
}

interface MissingSignal {
  service: string;
  signalKey: string;
  pattern: string;
  description: string;
  windowSeconds: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadManifest(path: string): {
  defaultWindow: number;
  signals: Record<string, SignalDef>;
  services: ServiceReq[];
} {
  if (!existsSync(path)) {
    console.error(`::error::signal manifest not found at ${path}`);
    process.exit(2);
  }
  const data = yaml.load(readFileSync(path, 'utf8')) as Manifest | null;
  if (!data || typeof data !== 'object') {
    console.error(`::error::manifest ${path} is not a YAML mapping`);
    process.exit(2);
  }
  return {
    defaultWindow: Number.parseInt(String(data.defaults?.window_seconds ?? 120), 10),
    signals: data.signal_library ?? {},
    services: Array.isArray(data.services) ? data.services : [],
  };
}

function composeServices(composeFile: string): string[] {
  const out = execFileSync('docker', ['compose', '-f', composeFile, 'config', '--services'], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function composeContainerIds(composeFile: string, service: string): string[] {
  const result = spawnSync('docker', ['compose', '-f', composeFile, 'ps', '-a', '-q', service], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  return (result.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function inspectStartedAt(containerId: string): string | undefined {
  const result = spawnSync('docker', ['inspect', '--format={{.State.StartedAt}}', containerId], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return undefined;
  const startedAt = (result.stdout ?? '').trim();
  if (!startedAt || startedAt.startsWith('0001-01-01')) return undefined;
  return startedAt;
}

function logsSinceForService(composeFile: string, service: string): string | undefined {
  if (BOOT_SIGNAL_SINCE) return BOOT_SIGNAL_SINCE;
  const started = composeContainerIds(composeFile, service)
    .map((id) => inspectStartedAt(id))
    .filter((value): value is string => value !== undefined)
    .sort();
  return started[0];
}

function fetchLogs(composeFile: string, service: string): string {
  const args = ['compose', '-f', composeFile, 'logs', '--no-color', '--no-log-prefix'];
  const since = logsSinceForService(composeFile, service);
  if (since) args.push('--since', since);
  args.push(service);

  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) return '';
  return result.stdout ?? '';
}

function parseDeployServices(): string[] {
  return (process.env['DEPLOY_SERVICES'] ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scopeServices(services: ServiceReq[]): ServiceReq[] {
  const deployServices = parseDeployServices();
  const isFullDeploy =
    process.env['FULL_DEPLOY'] === 'true' ||
    deployServices.length === 0 ||
    deployServices.includes('all');

  if (isFullDeploy) return services;

  const migrationRequired = process.env['RUN_DB_MIGRATE'] !== 'false';
  const scoped = new Set<string>(
    migrationRequired ? ['db-migrate', ...deployServices] : deployServices,
  );
  return services.filter((svc) => scoped.has(svc.name));
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function structuredField(record: Record<string, unknown>, field: string): unknown {
  if (field in record) return record[field];
  const extra = record['extra'];
  if (extra && typeof extra === 'object' && field in extra) {
    return (extra as Record<string, unknown>)[field];
  }
  return undefined;
}

function logsContainStructuredSignal(logs: string, signalKey: string, def: SignalDef): boolean {
  for (const line of logs.split('\n')) {
    const record = parseJsonRecord(line);
    if (!record) continue;
    if (
      record['message'] === def.pattern &&
      structuredField(record, 'bootSignal') === signalKey &&
      structuredField(record, 'status') === 'ok'
    ) {
      return true;
    }
  }
  return false;
}

function findMissing(
  services: ServiceReq[],
  signals: Record<string, SignalDef>,
  composeFile: string,
  defaultWindow: number,
): MissingSignal[] {
  const missing: MissingSignal[] = [];

  for (const svc of services) {
    const logs = fetchLogs(composeFile, svc.name);
    const windowSeconds = svc.window_seconds ?? defaultWindow;
    for (const key of svc.signals) {
      const def = signals[key];
      if (!def) {
        missing.push({
          service: svc.name,
          signalKey: key,
          pattern: '(undefined)',
          description: `signal "${key}" is not declared in signal_library`,
          windowSeconds,
        });
        continue;
      }
      const found =
        logsContainStructuredSignal(logs, key, def) ||
        (ALLOW_LEGACY_SUBSTRING && logs.includes(def.pattern));
      if (!found) {
        missing.push({
          service: svc.name,
          signalKey: key,
          pattern: def.pattern,
          description: def.description ?? '',
          windowSeconds,
        });
      }
    }
  }
  return missing;
}

async function main(): Promise<void> {
  const { defaultWindow, signals, services: manifestServices } = loadManifest(MANIFEST_PATH);
  const services = scopeServices(manifestServices);

  const composeSvcs = composeServices(COMPOSE_FILE);
  const unknown = services.map((s) => s.name).filter((n) => !composeSvcs.includes(n));
  if (unknown.length > 0) {
    console.error(`::error::signal manifest references services not in ${COMPOSE_FILE}:`);
    for (const name of unknown) console.error(`  - ${name}`);
    process.exit(2);
  }

  const startedAt = Date.now();

  console.log('=== Boot signal assertion ===');
  console.log(`  manifest: ${MANIFEST_PATH}`);
  console.log(`  compose : ${COMPOSE_FILE}`);
  console.log(`  scope   : ${services.length}/${manifestServices.length} manifest services`);
  console.log(
    `  logs    : ${BOOT_SIGNAL_SINCE ? `since ${BOOT_SIGNAL_SINCE}` : 'since container StartedAt'}`,
  );
  console.log(`  legacy  : ${ALLOW_LEGACY_SUBSTRING ? 'enabled' : 'disabled'}`);

  let missing: MissingSignal[] = [];
  let round = 1;
  for (;;) {
    missing = findMissing(services, signals, COMPOSE_FILE, defaultWindow);
    if (missing.length === 0) {
      console.log(`  all signals present (round ${round})`);
      break;
    }

    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    const expired = missing.filter((m) => elapsedSeconds >= m.windowSeconds);
    if (expired.length > 0) {
      missing = expired;
      break;
    }

    console.log(
      `--- Round ${round}: ${missing.length} signal(s) pending after ${elapsedSeconds}s ---`,
    );
    const nextDeadlineMs = startedAt + Math.min(...missing.map((m) => m.windowSeconds * 1000));
    const sleepMs = Math.min(POLL_INTERVAL * 1000, Math.max(0, nextDeadlineMs - Date.now()));
    if (sleepMs <= 0) break;
    await sleep(sleepMs);
    round += 1;
  }

  if (missing.length > 0) {
    console.error('::error::Missing boot signals:');
    for (const m of missing) {
      console.error(
        `  [${m.service}] ${m.signalKey} "${m.pattern}" ` +
          `(window ${m.windowSeconds}s) — ${m.description || m.signalKey}`,
      );
    }
    console.error(
      'Deploy failed: at least one service booted without emitting a ' +
        'required invariant signal. See signal_library.*.canonicalSource ' +
        'and emitterSources for the contract and emitting code paths.',
    );
    process.exit(1);
  }

  console.log('=== All required boot signals present ===');
  process.exit(0);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`::error::unhandled error: ${msg}`);
  process.exit(2);
});
