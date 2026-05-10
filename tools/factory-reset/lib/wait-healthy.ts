/**
 * wait-healthy — poll docker container health states until the SSoT
 * containers report `healthy`.
 *
 * Why this phase exists:
 *   `docker compose up -d` returns as soon as the containers START,
 *   not when they're ready. Migrations and seed run inside the auth
 *   container's ApplicationStartup hook. Without an explicit poll, the
 *   verify-seed phase races the seed and reports a phantom failure.
 *
 * Two waits, in order:
 *   1. postgres healthy        — ~30s on a warm host, 60s budget
 *   2. auth-service healthy    — must complete migrations + seed,
 *                                ~90s on a cold start, 120s budget
 *
 * Health is read from `docker inspect --format '{{.State.Health.Status}}'`
 * which mirrors what `docker ps` shows. If a container has no
 * healthcheck, .State.Health.Status is empty — we treat that as
 * "running == healthy" and check .State.Status instead.
 */

import { execSync } from 'node:child_process';

import { logInfo, logWarn } from './log.ts';

const PHASE = 'wait-healthy';

export interface WaitOptions {
  dryRun: boolean;
}

interface ContainerHealth {
  exists: boolean;
  status: string; // running, exited, ...
  health: string; // healthy, unhealthy, starting, '' (no healthcheck)
}

function inspectHealth(container: string): ContainerHealth {
  try {
    const raw = execSync(
      `docker inspect ${container} --format '{{.State.Status}}|{{.State.Health.Status}}'`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const [status, health] = raw.split('|');
    return { exists: true, status: status ?? '', health: health ?? '' };
  } catch {
    return { exists: false, status: '', health: '' };
  }
}

function isReady(h: ContainerHealth): boolean {
  if (!h.exists) return false;
  // Container has a healthcheck — trust it.
  if (h.health) return h.health === 'healthy';
  // No healthcheck declared — fall back to "running".
  return h.status === 'running';
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(container: string, timeoutSec: number): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastReport: ContainerHealth | null = null;
  let pollCount = 0;

  while (Date.now() < deadline) {
    const h = inspectHealth(container);
    pollCount++;

    if (isReady(h)) {
      logInfo(PHASE, 'container ready', {
        container,
        status: h.status,
        health: h.health || '(no healthcheck — using status)',
        polls: pollCount,
      });
      return;
    }

    // Log on every state transition so the operator sees progress.
    const stateChanged =
      !lastReport || lastReport.status !== h.status || lastReport.health !== h.health;
    if (stateChanged) {
      logInfo(PHASE, 'waiting', {
        container,
        status: h.status || '(missing)',
        health: h.health || '(none)',
      });
      lastReport = h;
    }

    await sleep(2_000);
  }

  throw new Error(
    `Timed out after ${timeoutSec}s waiting for ${container} to become healthy. ` +
      `Last state: status=${lastReport?.status ?? 'unknown'} health=${lastReport?.health ?? 'unknown'}`,
  );
}

export async function waitHealthy(opts: WaitOptions): Promise<void> {
  if (opts.dryRun) {
    logInfo(PHASE, '[dry-run] would wait for aqua-postgres healthy (60s budget)');
    logInfo(PHASE, '[dry-run] would wait for aqua-auth healthy (120s budget)');
    return;
  }

  logInfo(PHASE, 'waiting for aqua-postgres');
  await waitFor('aqua-postgres', 60);

  logInfo(PHASE, 'waiting for aqua-auth (migrations + seed in flight)');
  try {
    await waitFor('aqua-auth', 120);
  } catch (err) {
    // Surface a clearer message — auth-service health failure is the most
    // common reason for the reset to fail post-startup.
    logWarn(PHASE, 'aqua-auth not healthy in time — continuing to verify-seed for diagnostics', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
