/**
 * compose-down — `docker compose down -v` against the droplet compose
 * file. The `-v` flag is the load-bearing knob: it removes the SIX
 * named volumes (postgres_data, redis_data, nats_data, minio_data,
 * mosquitto_data, mosquitto_log) along with the stack. Without `-v`
 * the data persists across stack lifecycles and the reset is a no-op.
 *
 * This is the FIRST destructive step. Guards in factory-reset.ts MUST
 * have all passed before this is called.
 */

import { spawnSync } from 'node:child_process';

import { logError, logInfo } from './log.ts';

const PHASE = 'compose-down';

export interface ComposeDownOptions {
  composePath: string;
  dryRun: boolean;
}

export function composeDown(opts: ComposeDownOptions): void {
  const args = ['compose', '-f', opts.composePath, 'down', '-v', '--remove-orphans'];

  if (opts.dryRun) {
    logInfo(PHASE, '[dry-run] would execute', { command: 'docker', args });
    logInfo(PHASE, '[dry-run] would remove 6 named volumes', {
      volumes: [
        'postgres_data',
        'redis_data',
        'nats_data',
        'minio_data',
        'mosquitto_data',
        'mosquitto_log',
      ],
    });
    return;
  }

  logInfo(PHASE, 'executing docker compose down -v', { command: 'docker', args });
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    logError(PHASE, 'docker compose down failed', {
      status: result.status,
      signal: result.signal,
    });
    throw new Error(`docker compose down exited with status ${result.status ?? 'null'}`);
  }
  logInfo(PHASE, 'compose stack stopped and volumes removed');
}
