/**
 * volume-prep — re-create the postgres data volume with correct
 * ownership BEFORE compose-up runs.
 *
 * Why this phase exists (a real bug, documented architecturally):
 *   The HA TimescaleDB image (timescale/timescaledb-ha:pg16) and the
 *   custom postgres-ssl-entrypoint.sh both expect /var/lib/postgresql/data
 *   to be owned by uid 1000 (postgres). When `docker compose down -v`
 *   removes the volume and `up -d` re-creates it, the fresh volume is
 *   created on the host as root:root by default. Without prep, postgres
 *   exits during initdb with "could not change permissions" and the
 *   reset hangs at wait-healthy.
 *
 * The fix is to:
 *   1. Materialize the volume by creating it explicitly (docker volume
 *      create is idempotent — if compose-down didn't remove it for any
 *      reason we silently re-use).
 *   2. Run a one-shot busybox container that chowns the mount point
 *      to 1000:1000. We use the official busybox image because it ships
 *      chown, requires no network, and runs as root inside the
 *      container regardless of host user mapping.
 *
 * Project name detection:
 *   Compose prefixes named volumes with the project name. We detect
 *   the project by reading the COMPOSE_PROJECT_NAME env var, then
 *   falling back to the parent directory of the compose file (Compose
 *   default rule). The volume name fed to `docker volume create` is
 *   `<project>_postgres_data`.
 */

import { execSync, spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

import { logInfo, logWarn } from './log.ts';

const PHASE = 'volume-prep';

export interface VolumePrepOptions {
  composePath: string;
  dryRun: boolean;
}

/**
 * Compose project name resolution mirrors the docker compose CLI rule:
 * COMPOSE_PROJECT_NAME wins, otherwise the parent dir of the compose
 * file is used (lowercased, non-alnum stripped).
 */
function resolveProjectName(composePath: string): string {
  const fromEnv = process.env.COMPOSE_PROJECT_NAME;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  const parent = basename(dirname(resolve(composePath)));
  return parent.toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

export function prepPostgresVolume(opts: VolumePrepOptions): void {
  const project = resolveProjectName(opts.composePath);
  const volumeName = `${project}_postgres_data`;

  if (opts.dryRun) {
    logInfo(PHASE, '[dry-run] would create+chown postgres data volume', {
      volumeName,
      uid: 1000,
      gid: 1000,
    });
    return;
  }

  logInfo(PHASE, 'creating postgres data volume', { volumeName });
  // `docker volume create` is idempotent — it returns the name if the
  // volume already exists. Either way we reach the chown step with a
  // valid mount target.
  const create = spawnSync('docker', ['volume', 'create', volumeName], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (create.status !== 0) {
    logWarn(PHASE, 'docker volume create returned non-zero (continuing)', {
      status: create.status,
      stderr: create.stderr,
    });
  }

  logInfo(PHASE, 'chowning volume mount to 1000:1000', { volumeName });
  // Mount the volume into a busybox container at /data and chown.
  // --rm cleans up the container after the chown returns.
  const chown = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${volumeName}:/data`,
      'busybox:1.36',
      'chown',
      '-R',
      '1000:1000',
      '/data',
    ],
    { stdio: 'inherit' },
  );
  if (chown.status !== 0) {
    throw new Error(
      `chown of ${volumeName} via busybox failed with status ${chown.status ?? 'null'}`,
    );
  }
  logInfo(PHASE, 'volume ownership corrected', { volumeName, owner: '1000:1000' });

  // Sanity: print volume metadata for the audit trail.
  try {
    const info = execSync(`docker volume inspect ${volumeName} --format '{{.Mountpoint}}'`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    logInfo(PHASE, 'volume mountpoint resolved', { volumeName, mountpoint: info });
  } catch {
    // Best-effort observability only.
  }
}
