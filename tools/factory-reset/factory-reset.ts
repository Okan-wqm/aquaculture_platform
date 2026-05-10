#!/usr/bin/env node
/**
 * factory-reset.ts — one-shot operator CLI to reset the live droplet's
 * data state to "ilk gün" (day-one).
 *
 * Reset scope (irreversible):
 *   - drops the SIX docker-compose volumes (postgres_data, redis_data,
 *     nats_data, minio_data, mosquitto_data, mosquitto_log)
 *   - restarts the stack (excluding sensor-ingestion which has no
 *     published image yet)
 *   - init scripts populate empty schemas
 *   - service migrations run
 *   - auth-service SeedService re-creates by-okan@live.com SUPER_ADMIN
 *
 * Three concurrent guardrails (architectural-fix-tier-3 "make the
 * destructive action detectable + intentional"):
 *   1. --execute flag (default --dry-run)
 *   2. FACTORY_RESET_ALLOWED=1 env var (prevents accidental CI runs)
 *   3. stdin literal match "FACTORY RESET" (prevents fat-finger)
 *
 * Exit codes:
 *   0 — success (or successful dry-run)
 *   1 — failure during execution
 *   2 — usage error (unknown flag, missing arg)
 *   3 — abort due to guard violation (env, stdin, etc.)
 *
 * Usage:
 *   node --experimental-strip-types tools/factory-reset/factory-reset.ts
 *   FACTORY_RESET_ALLOWED=1 node --experimental-strip-types \
 *     tools/factory-reset/factory-reset.ts --execute
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { emitAudit } from './lib/audit-emit.ts';
import { composeDown } from './lib/compose-down.ts';
import { composeUp } from './lib/compose-up.ts';
import { logError, logInfo, logWarn } from './lib/log.ts';
import { runPreflight } from './lib/preflight.ts';
import { verifySeed } from './lib/verify-seed.ts';
import { prepPostgresVolume } from './lib/volume-prep.ts';
import { waitHealthy } from './lib/wait-healthy.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILE = resolve(REPO_ROOT, 'docker-compose.droplet.yml');
const PHASE = 'main';

const PHASE_ORDER: readonly string[] = [
  'preflight',
  'compose-down',
  'volume-prep',
  'compose-up',
  'wait-healthy',
  'verify-seed',
  'audit-emit',
];

interface CliArgs {
  execute: boolean;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let execute = false;
  let dryRun = false;
  let explicitMode = false;

  for (const arg of argv.slice(2)) {
    switch (arg) {
      case '--execute':
        execute = true;
        explicitMode = true;
        break;
      case '--dry-run':
        dryRun = true;
        explicitMode = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        process.stderr.write(`unknown argument: ${arg}\n`);
        printUsage();
        process.exit(2);
    }
  }

  // Default mode is dry-run when no mode flag is supplied — the safe
  // default (per the architectural-only / no-patches rule, the default
  // must be the non-destructive one).
  if (!explicitMode) {
    dryRun = true;
  }

  if (execute && dryRun) {
    process.stderr.write('--execute and --dry-run are mutually exclusive\n');
    process.exit(2);
  }

  return { execute, dryRun: dryRun || !execute };
}

function printUsage(): void {
  process.stderr.write(
    [
      'Usage: factory-reset.ts [--dry-run | --execute]',
      '',
      'Default: --dry-run (no destructive action).',
      '',
      'Real execution requires THREE concurrent guardrails:',
      '  1. --execute flag',
      '  2. FACTORY_RESET_ALLOWED=1 env var',
      '  3. stdin literal "FACTORY RESET" confirmation',
      '',
      'Exit codes: 0 ok | 1 fail | 2 usage | 3 guard abort',
      '',
    ].join('\n'),
  );
}

/**
 * Read one line of stdin (no echo control — the input is non-secret).
 * Resolves to '' if stdin closes before EOL.
 */
async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => {
    rl.question(prompt, (answer) => {
      rl.close();
      res(answer);
    });
  });
}

function readGitSha(): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Best-effort snapshot of tenant + user counts BEFORE the reset.
 * Failures are non-fatal — we only need this for the audit metadata.
 */
function snapshotBeforeCounts(): { tenants: number; users: number } {
  try {
    const out = execSync(
      `docker exec -i aqua-postgres psql -U ${process.env.POSTGRES_USER ?? 'aquaculture'} -d ${
        process.env.POSTGRES_DB ?? 'aquaculture'
      } -tA -c "SELECT (SELECT COUNT(*) FROM auth.tenants) || ',' || (SELECT COUNT(*) FROM auth.users)"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const [tenantsStr, usersStr] = out.split(',');
    return {
      tenants: Number(tenantsStr ?? 0) || 0,
      users: Number(usersStr ?? 0) || 0,
    };
  } catch {
    return { tenants: -1, users: -1 };
  }
}

async function enforceExecuteGuards(): Promise<void> {
  // Guard 2: env var must be set to literal "1"
  if (process.env.FACTORY_RESET_ALLOWED !== '1') {
    logError(
      PHASE,
      'FACTORY_RESET_ALLOWED env var not set to "1"; refusing to proceed. ' +
        'Set FACTORY_RESET_ALLOWED=1 in the shell that runs --execute.',
    );
    process.exit(3);
  }
  // Guard 3: stdin literal match
  const answer = await readLine('Type \'FACTORY RESET\' to confirm: ');
  if (answer !== 'FACTORY RESET') {
    logError(PHASE, 'stdin confirmation did not match literal "FACTORY RESET"; aborting.', {
      received: answer,
    });
    process.exit(3);
  }
  logInfo(PHASE, 'all three guards passed', {
    flag: '--execute',
    env: 'FACTORY_RESET_ALLOWED=1',
    stdin: 'matched',
  });
}

/**
 * Read SUPER_ADMIN_EMAIL from the auth container or compose file —
 * we need it for the audit row's userEmail column. Mirrors the logic
 * in preflight but returns a concrete string with a deterministic
 * fallback to the platform owner's address.
 */
function resolveSuperAdminEmail(composePath: string): string {
  // Try running container first.
  try {
    const raw = execSync(
      "docker inspect aqua-auth --format '{{range .Config.Env}}{{println .}}{{end}}'",
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const line of raw.split('\n')) {
      if (line.startsWith('SUPER_ADMIN_EMAIL=')) {
        const v = line.slice('SUPER_ADMIN_EMAIL='.length).trim();
        if (v.length > 0) return v;
      }
    }
  } catch {
    // fall through
  }
  // Try compose file.
  if (existsSync(composePath)) {
    const src = readFileSync(composePath, 'utf8');
    const m = src.match(/SUPER_ADMIN_EMAIL:\s*([^\s#}]+)/);
    if (m && m[1]) return m[1].replace(/['"]/g, '');
  }
  // Last-resort default — the platform owner's SUPER_ADMIN address.
  return 'by-okan@live.com';
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  const dryRun = args.dryRun;

  logInfo(PHASE, 'factory-reset starting', {
    mode: dryRun ? 'dry-run' : 'execute',
    composePath: COMPOSE_FILE,
    repoRoot: REPO_ROOT,
    pid: process.pid,
    nodeVersion: process.version,
  });

  if (dryRun) {
    logInfo(PHASE, 'dry-run plan', {
      phases: PHASE_ORDER,
      destructive: false,
      note:
        'No destructive action will be taken. The plan below describes ' +
        'what each phase WOULD do during --execute.',
    });
  } else {
    await enforceExecuteGuards();
  }

  // ---- Phase 1: preflight ----
  const preflight = runPreflight(COMPOSE_FILE);
  if (!dryRun && (!preflight.superAdminEmailConfigured || !preflight.superAdminPasswordConfigured)) {
    // In execute mode we proceed but loudly — the operator may have set
    // the vars in the shell that runs the auth container; preflight
    // can't see those reliably.
    logWarn(PHASE, 'proceeding with SUPER_ADMIN env warnings — verify-seed will catch a real gap');
  }

  // Snapshot BEFORE counts for the audit metadata. Skip in dry-run
  // because the postgres container may not be running on a fresh CI
  // host and there's nothing to record.
  const beforeCounts = dryRun ? { tenants: -1, users: -1 } : snapshotBeforeCounts();
  if (!dryRun) {
    logInfo(PHASE, 'pre-reset snapshot', beforeCounts);
  }

  // ---- Phase 2: compose-down ----
  composeDown({ composePath: COMPOSE_FILE, dryRun });

  // ---- Phase 3: volume-prep ----
  prepPostgresVolume({ composePath: COMPOSE_FILE, dryRun });

  // ---- Phase 4: compose-up ----
  composeUp({ composePath: COMPOSE_FILE, dryRun });

  // ---- Phase 5: wait-healthy ----
  await waitHealthy({ dryRun });

  // ---- Phase 6: verify-seed ----
  const seedResult = verifySeed({ dryRun });

  // ---- Phase 7: audit-emit ----
  const gitSha = readGitSha();
  emitAudit({
    superAdminUserId: seedResult.superAdminUserId,
    superAdminEmail: resolveSuperAdminEmail(COMPOSE_FILE),
    gitSha,
    metadata: {
      tenants_before: beforeCounts.tenants,
      users_before: beforeCounts.users,
      tenants_after: 0,
      users_after: seedResult.rowCount,
    },
    dryRun,
  });

  logInfo(PHASE, dryRun ? 'dry-run complete (no changes made)' : 'factory reset complete', {
    phases: PHASE_ORDER,
    gitSha,
  });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logError(PHASE, 'factory-reset failed', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
