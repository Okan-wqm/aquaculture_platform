/**
 * compose-up — bring the stack back online MINUS sensor-ingestion.
 *
 * Why we exclude sensor-ingestion:
 *   sensor-ingestion is the Rust sidecar from the hybrid migration plan
 *   (project_rust_migration.md). It does not yet have a published
 *   container image — the droplet build pipeline does not produce one,
 *   so `docker compose up -d sensor-ingestion` would attempt to pull a
 *   missing image and fail the entire stack. Excluding it keeps the
 *   reset deterministic. When the image lands, this file should be
 *   updated to drop the exclusion (the comment below names the line).
 *
 * Implementation:
 *   We parse the service list out of the compose file via
 *   `docker compose config --services`, drop sensor-ingestion, and
 *   pass the remaining names to `up -d`.
 */

import { execSync, spawnSync } from 'node:child_process';

import { logInfo } from './log.ts';

const PHASE = 'compose-up';

const EXCLUDED_SERVICES: ReadonlySet<string> = new Set([
  // DROP THIS ENTRY when the Rust sidecar publishes a release image.
  'sensor-ingestion',
]);

export interface ComposeUpOptions {
  composePath: string;
  dryRun: boolean;
}

function listServices(composePath: string): readonly string[] {
  // `--no-interpolate` is load-bearing: without it, `compose config`
  // resolves every ${VAR:?required-msg} marker even though we only
  // need the service-name list. The droplet compose file uses
  // `${POSTGRES_PASSWORD:?...}` and many other `:?required` markers
  // that are NOT set in the dry-run host shell — interpolation would
  // fail there spuriously. We do NOT need values, only names, so the
  // no-interpolate path gives us a stable, env-independent service
  // list across every host that has a working docker CLI.
  const out = execSync(
    `docker compose -f ${composePath} config --services --no-interpolate`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function composeUp(opts: ComposeUpOptions): void {
  const services = listServices(opts.composePath);
  const eligible = services.filter((s) => !EXCLUDED_SERVICES.has(s));
  const excluded = services.filter((s) => EXCLUDED_SERVICES.has(s));

  logInfo(PHASE, 'service plan resolved', {
    totalDeclared: services.length,
    eligibleCount: eligible.length,
    excludedCount: excluded.length,
    excluded,
  });

  const args = ['compose', '-f', opts.composePath, 'up', '-d', ...eligible];

  if (opts.dryRun) {
    logInfo(PHASE, '[dry-run] would execute', { command: 'docker', args });
    return;
  }

  logInfo(PHASE, 'starting stack', { eligible });
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`docker compose up exited with status ${result.status ?? 'null'}`);
  }
  logInfo(PHASE, 'stack started');
}
