#!/usr/bin/env node
/**
 * WS6 / ADR-016 Phase C — criticality-aware deploy health gate.
 *
 * Reads `infrastructure/deploy/service-criticality.yaml` and polls
 * every listed container for docker-inspect health state. Fails the
 * deploy according to the criticality level declared in the manifest.
 *
 * Replaces the legacy "poll only gateway-api /health/live" check that
 * silently passed when other backends crash-looped (the 2026-04-14
 * cascade failure mode).
 *
 * Runs on the droplet via SSH — Node.js is already required there
 * because the service images are Node-based. Node 22's built-in
 * type-stripping lets us ship a .ts file without a transpile step.
 *
 * Environment:
 *   COMPOSE_FILE   compose file path (default: docker-compose.droplet.yml)
 *   MANIFEST       override manifest path
 *   POLL_INTERVAL  seconds between polling rounds (default: 10)
 *
 * Exit codes:
 *   0  every `critical` / `required` service is healthy
 *   1  at least one `critical` service failed; caller should rollback
 *   2  invocation error
 *   3  at least one `required` service failed; caller should fail without rollback
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import {
  entryProfiles,
  isProfileActive,
  parseActiveProfiles,
  profileLabel,
} from './compose-profile-contract.ts';

const COMPOSE_FILE = process.env['COMPOSE_FILE'] ?? 'docker-compose.droplet.yml';
const MANIFEST_PATH = process.env['MANIFEST'] ?? 'infrastructure/deploy/service-criticality.yaml';
const POLL_INTERVAL = Number.parseInt(process.env['POLL_INTERVAL'] ?? '10', 10);

type CriticalityLevel = 'critical' | 'required' | 'warning' | 'ignored';

interface ManifestEntry {
  name: string;
  level: CriticalityLevel;
  profiles?: string[];
  reason?: string;
}

interface Manifest {
  schema_version?: number;
  // readiness_sla_seconds is DERIVED into this generated manifest from the
  // platform service catalog (max critical startupBudgetSeconds + margin).
  // It is the ONLY source of the SLA — there is no silent default; an absent
  // value is a generation failure that must fail the gate loudly, not fall
  // back to a magic number that can mask a broken/stale manifest.
  defaults?: { readiness_sla_seconds?: number };
  services?: ManifestEntry[];
}

interface ContainerState {
  service: string;
  container: string;
  health: string; // "healthy" / "unhealthy" / "starting" / ""
  state: string; // "running" / "exited" / ...
  hasHealthcheck: boolean;
}

interface ContainerRuntime {
  health: string;
  state: string;
  hasHealthcheck: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadManifest(path: string): { services: ManifestEntry[]; sla: number } {
  if (!existsSync(path)) {
    console.error(`::error::manifest not found at ${path}`);
    process.exit(2);
  }
  const data = yaml.load(readFileSync(path, 'utf8')) as Manifest | null;
  // The manifest is generated from the platform service catalog and ALWAYS
  // carries a derived defaults.readiness_sla_seconds. There is no fallback
  // default: a missing/non-numeric value means the manifest is stale or
  // hand-broken, which must fail the deploy gate, not silently assume a number.
  const sla = data?.defaults?.readiness_sla_seconds;
  if (typeof sla !== 'number' || !Number.isFinite(sla) || sla <= 0) {
    console.error(
      `::error::manifest ${path} is missing a valid defaults.readiness_sla_seconds ` +
        '(generated from the platform service catalog) — regenerate service-criticality.yaml',
    );
    process.exit(2);
  }
  const services = Array.isArray(data?.services) ? data!.services! : [];
  return { services, sla };
}

function composeServices(composeFile: string): string[] {
  const out = execFileSync('docker', ['compose', '-f', composeFile, 'config', '--services'], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

/**
 * Read the authoritative healthcheck declaration and current status directly
 * from Docker. `docker compose ps --format json` can transiently omit Health
 * while a healthchecked container is restarting; an empty field therefore
 * cannot prove that the image has no healthcheck.
 */
function inspectContainerRuntime(containers: string[]): Map<string, ContainerRuntime> {
  const uniqueContainers = [...new Set(containers.filter(Boolean))];
  if (uniqueContainers.length === 0) return new Map();

  const format =
    '{{.Name}}\t{{if .Config.Healthcheck}}true{{else}}false{{end}}\t' +
    '{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.State.Status}}';
  const result = spawnSync('docker', ['inspect', '--format', format, ...uniqueContainers], {
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(`[health-gate] docker inspect failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `[health-gate] docker inspect failed for ${uniqueContainers.length} container(s) ` +
        `(exit ${String(result.status)})`,
    );
  }

  const runtimes = new Map<string, ContainerRuntime>();
  for (const line of (result.stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    const [rawName, declared, health = '', state = ''] = line.split('\t');
    const name = (rawName ?? '').replace(/^\//, '');
    if (!name || (declared !== 'true' && declared !== 'false')) {
      throw new Error(`[health-gate] malformed docker inspect output for ${name || 'container'}`);
    }
    runtimes.set(name, {
      hasHealthcheck: declared === 'true',
      health: health.toLowerCase(),
      state: state.toLowerCase(),
    });
  }
  return runtimes;
}

/**
 * Collect `{ service, container, health, state }` for every container
 * reported by `docker compose ps --format json`. Both compose v2.21+
 * (NDJSON) and v2.29+ (JSON array) shapes are handled.
 */
function currentStates(composeFile: string): Map<string, ContainerState> {
  const result = spawnSync('docker', ['compose', '-f', composeFile, 'ps', '--format', 'json'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return new Map();
  const raw = (result.stdout ?? '').trim();
  if (!raw) return new Map();

  let objects: Array<Record<string, unknown>>;
  if (raw.startsWith('[')) {
    objects = JSON.parse(raw) as Array<Record<string, unknown>>;
  } else {
    objects = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  const containerNames = objects.map((obj) => String(obj['Name'] ?? '')).filter(Boolean);
  const runtimes = inspectContainerRuntime(containerNames);
  const states = new Map<string, ContainerState>();
  for (const obj of objects) {
    const svc = obj['Service'];
    if (typeof svc !== 'string' || !svc) continue;
    const container = String(obj['Name'] ?? '');
    const runtime = runtimes.get(container);
    if (!runtime) {
      throw new Error(`[health-gate] docker inspect omitted compose container ${container}`);
    }
    states.set(svc, {
      service: svc,
      container,
      health: runtime.health,
      state: runtime.state,
      hasHealthcheck: runtime.hasHealthcheck,
    });
  }
  return states;
}

/**
 * A container is "satisfied" for its criticality level when either:
 *   - its health is `healthy`, OR
 *   - Docker confirms it has no declared healthcheck and its docker
 *     state is `running` — some compose entries intentionally omit a
 *     healthcheck (nginx frontends, etc) and must still gate on simple
 *     liveness.
 *
 * `ignored` entries always count as satisfied.
 */
function isSatisfied(entry: ManifestEntry, state: ContainerState | undefined): boolean {
  if (entry.level === 'ignored') return true;
  if (!state) return false;
  if (state.health === 'healthy') return true;
  if (!state.hasHealthcheck && state.state === 'running') return true;
  return false;
}

function report(
  manifest: ManifestEntry[],
  states: Map<string, ContainerState>,
  slaSeconds: number,
): number {
  console.log('=== Final state ===');
  let failCritical = 0;
  let failRequired = 0;
  let warnings = 0;

  for (const entry of manifest) {
    if (entry.level === 'ignored') continue;
    const state = states.get(entry.name);
    const detail = state
      ? `container=${state.container} health=${state.health || 'n/a'} ` +
        `healthcheck=${state.hasHealthcheck ? 'declared' : 'none'} state=${state.state}`
      : 'container not found';
    console.log(`  [${entry.level.padEnd(8)}] ${entry.name} — ${detail}`);

    const ok = isSatisfied(entry, state);
    if (entry.level === 'critical' && !ok) failCritical += 1;
    else if (entry.level === 'required' && !ok) failRequired += 1;
    else if (entry.level === 'warning' && !ok) warnings += 1;
  }

  if (failCritical > 0) {
    console.error(
      `::error::${failCritical} critical service(s) failed to reach ` +
        `healthy within ${slaSeconds}s SLA. Rollback required.`,
    );
    return 1;
  }
  if (failRequired > 0) {
    console.error(
      `::error::${failRequired} required service(s) failed. Operator ` +
        'investigation required before declaring success.',
    );
    return 3;
  }
  if (warnings > 0) {
    console.warn(
      `::warning::${warnings} non-critical service(s) are not healthy ` +
        '— deploy proceeding but follow up.',
    );
  }
  console.log('=== Service health check passed ===');
  return 0;
}

async function main(): Promise<void> {
  const { services: manifest, sla } = loadManifest(MANIFEST_PATH);
  const activeProfiles = parseActiveProfiles();
  const activeManifest = manifest.filter((entry) => isProfileActive(entry, activeProfiles));
  const skippedManifest = manifest.filter((entry) => !isProfileActive(entry, activeProfiles));

  // Coverage check: every manifest entry must name a real compose
  // service in the active profile set. Profile-gated services are
  // classified in the manifest, but only polled when the corresponding
  // Compose profile is enabled.
  const composeSvcs = composeServices(COMPOSE_FILE);
  const missing = activeManifest.map((e) => e.name).filter((n) => !composeSvcs.includes(n));
  if (missing.length > 0) {
    console.error(`::error::manifest references services not in ${COMPOSE_FILE}:`);
    for (const name of missing) console.error(`  - ${name}`);
    process.exit(2);
  }

  const maxRounds = Math.max(1, Math.floor(sla / POLL_INTERVAL));
  console.log('=== Service health check ===');
  console.log(`  manifest: ${MANIFEST_PATH}`);
  console.log(`  compose : ${COMPOSE_FILE}`);
  console.log(`  profiles: ${profileLabel([...activeProfiles].sort())}`);
  console.log(`  SLA     : ${sla}s (${maxRounds} rounds × ${POLL_INTERVAL}s)`);
  for (const entry of skippedManifest) {
    console.log(
      `  skip profile-gated service: ${entry.name} ` +
        `(profiles=${profileLabel(entryProfiles(entry))})`,
    );
  }

  let states: Map<string, ContainerState> = new Map();
  for (let round = 1; round <= maxRounds; round += 1) {
    console.log(`--- Round ${round}/${maxRounds} ---`);
    states = currentStates(COMPOSE_FILE);

    const blockingOk = activeManifest
      .filter((e) => e.level === 'critical' || e.level === 'required')
      .every((e) => isSatisfied(e, states.get(e.name)));

    if (blockingOk) {
      console.log('  all critical/required services satisfied');
      break;
    }

    if (round < maxRounds) {
      await sleep(POLL_INTERVAL * 1000);
    }
  }

  process.exit(report(activeManifest, states, sla));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`::error::unhandled error: ${msg}`);
  process.exit(2);
});
