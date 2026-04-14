#!/usr/bin/env node
/**
 * WS7 / ADR-016 Phase F — boot signal assertion.
 *
 * Scrapes `docker compose logs` for each service declared in
 * `infrastructure/deploy/required-signals.yaml` and fails the deploy
 * if any required substring is missing within the per-service SLA.
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
 *   COMPOSE_FILE    compose file (default: docker-compose.droplet.yml)
 *   MANIFEST        override manifest path
 *   POLL_INTERVAL   seconds between polling rounds (default: 10)
 *
 * Exit codes:
 *   0  every required signal present for every declared service
 *   1  at least one signal missing within window
 *   2  invocation error
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const COMPOSE_FILE =
  process.env['COMPOSE_FILE'] ?? 'docker-compose.droplet.yml';
const MANIFEST_PATH =
  process.env['MANIFEST'] ?? 'infrastructure/deploy/required-signals.yaml';
const POLL_INTERVAL = Number.parseInt(
  process.env['POLL_INTERVAL'] ?? '10',
  10,
);

interface SignalDef {
  pattern: string;
  description?: string;
  signalSource?: string;
}

interface ServiceReq {
  name: string;
  signals: string[];          // references into signal_library
  window_seconds?: number;
}

interface Manifest {
  schema_version?: number;
  defaults?: { window_seconds?: number };
  signal_library?: Record<string, SignalDef>;
  services?: ServiceReq[];
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
    defaultWindow: Number.parseInt(
      String(data.defaults?.window_seconds ?? 120),
      10,
    ),
    signals: data.signal_library ?? {},
    services: Array.isArray(data.services) ? data.services : [],
  };
}

function composeServices(composeFile: string): string[] {
  const out = execFileSync(
    'docker',
    ['compose', '-f', composeFile, 'config', '--services'],
    { encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function fetchLogs(composeFile: string, service: string): string {
  const result = spawnSync(
    'docker',
    ['compose', '-f', composeFile, 'logs', '--no-color', '--no-log-prefix', service],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return '';
  return result.stdout ?? '';
}

interface MissingSignal {
  service: string;
  signalKey: string;
  pattern: string;
  description: string;
}

function findMissing(
  services: ServiceReq[],
  signals: Record<string, SignalDef>,
  composeFile: string,
): MissingSignal[] {
  const missing: MissingSignal[] = [];

  for (const svc of services) {
    const logs = fetchLogs(composeFile, svc.name);
    for (const key of svc.signals) {
      const def = signals[key];
      if (!def) {
        missing.push({
          service: svc.name,
          signalKey: key,
          pattern: '(undefined)',
          description: `signal "${key}" is not declared in signal_library`,
        });
        continue;
      }
      if (!logs.includes(def.pattern)) {
        missing.push({
          service: svc.name,
          signalKey: key,
          pattern: def.pattern,
          description: def.description ?? '',
        });
      }
    }
  }
  return missing;
}

async function main(): Promise<void> {
  const { defaultWindow, signals, services } = loadManifest(MANIFEST_PATH);

  // Coverage check — every declared service must exist in compose.
  const composeSvcs = composeServices(COMPOSE_FILE);
  const unknown = services
    .map((s) => s.name)
    .filter((n) => !composeSvcs.includes(n));
  if (unknown.length > 0) {
    console.error(
      `::error::signal manifest references services not in ${COMPOSE_FILE}:`,
    );
    for (const name of unknown) console.error(`  - ${name}`);
    process.exit(2);
  }

  // Compute the global max window — poll until this elapses or every
  // signal is present.
  const maxWindow = services.reduce(
    (acc, s) => Math.max(acc, s.window_seconds ?? defaultWindow),
    defaultWindow,
  );
  const maxRounds = Math.max(1, Math.floor(maxWindow / POLL_INTERVAL));

  console.log('=== Boot signal assertion ===');
  console.log(`  manifest: ${MANIFEST_PATH}`);
  console.log(`  compose : ${COMPOSE_FILE}`);
  console.log(`  window  : ${maxWindow}s (${maxRounds} rounds × ${POLL_INTERVAL}s)`);
  console.log(`  services: ${services.length}`);

  let missing: MissingSignal[] = [];
  for (let round = 1; round <= maxRounds; round += 1) {
    missing = findMissing(services, signals, COMPOSE_FILE);
    if (missing.length === 0) {
      console.log(
        `  all signals present (round ${round}/${maxRounds})`,
      );
      break;
    }
    console.log(
      `--- Round ${round}/${maxRounds}: ${missing.length} signal(s) pending ---`,
    );
    if (round < maxRounds) {
      await sleep(POLL_INTERVAL * 1000);
    }
  }

  if (missing.length > 0) {
    console.error('::error::Missing boot signals:');
    for (const m of missing) {
      console.error(
        `  [${m.service}] "${m.pattern}" — ${m.description || m.signalKey}`,
      );
    }
    console.error(
      'Deploy failed: at least one service booted without emitting a ' +
        'required invariant signal. See signal_library.*.signalSource ' +
        'for the code path that should have emitted the missing string.',
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
