/**
 * The collector's Prometheus textfile, read by the droplet's node exporter
 * and by the alerts in infrastructure/monitoring/droplet/rules/
 * 65-host-maintenance.yml. Every pass writes it, including one that could
 * not run. Two stamps are carried from the previous file so an alert can
 * ask "how long since": the last pass that completed, and since when the
 * collector has been unarmed. The unit's ExecCondition writes exit code 4
 * when the deployed checkout does not carry the script yet.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PassMetrics {
  exitCode: number;
  armed: boolean;
  outcomes: Record<
    'removed' | 'would_remove' | 'remove_failed' | 'remove_refused' | 'attention',
    number
  >;
  bytesReclaimed: number | null;
}

const LAST_SUCCESS = 'aqua_worktree_gc_last_success_timestamp_seconds';
const UNARMED_SINCE = 'aqua_worktree_gc_unarmed_since_timestamp_seconds';

function previousStamp(text: string, metric: string): number | null {
  const match = new RegExp(`^${metric} (\\d+)$`, 'm').exec(text);
  return match?.[1] ? Number(match[1]) : null;
}

export function renderTextfile(metrics: PassMetrics, nowSeconds: number, previous: string): string {
  const completed = metrics.exitCode === 0 || metrics.exitCode === 3;
  const lastSuccess = completed ? nowSeconds : previousStamp(previous, LAST_SUCCESS);
  const unarmedSince = metrics.armed
    ? null
    : (previousStamp(previous, UNARMED_SINCE) ?? nowSeconds);
  const lines = [
    '# HELP aqua_worktree_gc_last_run_timestamp_seconds Unix time of the last worktree-gc pass',
    '# TYPE aqua_worktree_gc_last_run_timestamp_seconds gauge',
    `aqua_worktree_gc_last_run_timestamp_seconds ${nowSeconds}`,
    '# HELP aqua_worktree_gc_last_exit_code 0 ok, 3 partial (a removal refused or failed), 1 could not run, 4 not deployed',
    '# TYPE aqua_worktree_gc_last_exit_code gauge',
    `aqua_worktree_gc_last_exit_code ${metrics.exitCode}`,
    '# HELP aqua_worktree_gc_armed 1 when the pass may remove worktrees',
    '# TYPE aqua_worktree_gc_armed gauge',
    `aqua_worktree_gc_armed ${metrics.armed ? 1 : 0}`,
    '# HELP aqua_worktree_gc_worktrees Worktrees on the last pass, by outcome',
    '# TYPE aqua_worktree_gc_worktrees gauge',
    ...Object.entries(metrics.outcomes).map(
      ([outcome, n]) => `aqua_worktree_gc_worktrees{outcome="${outcome}"} ${n}`,
    ),
    '# HELP aqua_worktree_gc_bytes_reclaimed_estimate Bytes removed (or removable) on the last pass; -1 unmeasured',
    '# TYPE aqua_worktree_gc_bytes_reclaimed_estimate gauge',
    `aqua_worktree_gc_bytes_reclaimed_estimate ${metrics.bytesReclaimed ?? -1}`,
  ];
  if (lastSuccess !== null) {
    lines.push(
      `# HELP ${LAST_SUCCESS} Unix time of the last pass that completed (exit 0 or 3)`,
      `# TYPE ${LAST_SUCCESS} gauge`,
      `${LAST_SUCCESS} ${lastSuccess}`,
    );
  }
  if (unarmedSince !== null) {
    lines.push(
      `# HELP ${UNARMED_SINCE} Unix time since which every pass has been unarmed`,
      `# TYPE ${UNARMED_SINCE} gauge`,
      `${UNARMED_SINCE} ${unarmedSince}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function writeTextfile(path: string | null, metrics: PassMetrics): void {
  if (path === null) return;
  let previous = '';
  try {
    previous = readFileSync(path, 'utf8');
  } catch {
    // First pass on this host, or the file was cleared: nothing to carry.
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      `${path}.tmp`,
      renderTextfile(metrics, Math.floor(Date.now() / 1000), previous),
      'utf8',
    );
    renameSync(`${path}.tmp`, path);
  } catch {
    // The journal lines still carry everything; a missing textfile
    // directory must not turn a completed pass into a failure.
  }
}
