#!/usr/bin/env ts-node
/**
 * aqua-ctl — platform operator CLI. Ships with the db-migrate
 * enterprise refactor (plan v3 R16).
 * ============================================================================
 *
 * Replaces the plan v2 pattern of "ssh droplet; vi .env; restart
 * service" — no audit trail, no TTL, no reason capture — with
 * structured, durable override records persisted in
 * `observability.emergency_overrides`.
 *
 * # Subcommands
 *
 *   aqua-ctl drift-bypass   # issue / revoke a SCHEMA_DRIFT_FATAL bypass
 *   aqua-ctl list-overrides # show active (non-expired) overrides
 *
 * # Authentication
 *
 * Reads connection via DATABASE_URL (or per-component DATABASE_* env vars).
 * Actor is read from $GITHUB_USER / $SUDO_USER / $USER in priority order.
 * Never anonymous — the CLI refuses to write without a resolved actor.
 *
 * # Design
 *
 * Pure TypeScript + pg driver — no NestJS runtime. The CLI runs as a
 * standalone process against the same observability DB the platform
 * uses. Exit codes mirror the existing tools/gates/ conventions:
 * 0 success, 1 validation failure, 2 usage / configuration error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const VALID_SERVICE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_REASON_LENGTH = 2048;

/**
 * Duration parser — accepts `<n>s`, `<n>m`, `<n>h`, `<n>d` with an
 * upper bound of 7 days. No "weeks" / "months" — overrides shouldn't
 * live longer than an incident response window.
 */
export function parseTtl(s: string): number {
  if (typeof s !== 'string' || s.length === 0) {
    throw new RangeError(`[aqua-ctl] --ttl must be a non-empty string`);
  }
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) {
    throw new RangeError(
      `[aqua-ctl] --ttl must match <number><s|m|h|d> (got '${s}')`,
    );
  }
  const value = Number.parseInt(m[1]!, 10);
  const unit = m[2]!;
  const multiplier: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const ms = value * multiplier[unit]!;
  const SEVEN_DAYS_MS = 7 * 86_400_000;
  if (ms < 60_000) {
    throw new RangeError(
      `[aqua-ctl] --ttl must be at least 1m (got ${s})`,
    );
  }
  if (ms > SEVEN_DAYS_MS) {
    throw new RangeError(
      `[aqua-ctl] --ttl must be at most 7d (got ${s}). Longer-term overrides ` +
        `require an ADR not a CLI invocation.`,
    );
  }
  return ms;
}

export function resolveActor(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = ['GITHUB_USER', 'SUDO_USER', 'USER', 'USERNAME'];
  for (const k of candidates) {
    const v = env[k];
    if (typeof v === 'string' && v.length > 0 && v !== 'root') {
      return v;
    }
  }
  throw new Error(
    `[aqua-ctl] cannot resolve actor — set GITHUB_USER (recommended), SUDO_USER, or USER. Never runs as anonymous.`,
  );
}

export interface DriftBypassArgs {
  readonly service: string;
  readonly reason: string;
  readonly ttlMs: number;
  readonly environment: string;
  readonly actor: string;
  readonly dryRun: boolean;
}

export function parseDriftBypassArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DriftBypassArgs {
  let service: string | undefined;
  let reason: string | undefined;
  let ttl: string | undefined;
  let environment: string = env['AQUA_ENV'] ?? 'development';
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--service':
        service = argv[++i];
        break;
      case '--reason':
        reason = argv[++i];
        break;
      case '--ttl':
        ttl = argv[++i];
        break;
      case '--environment':
        environment = argv[++i]!;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        throw new Error(`[aqua-ctl drift-bypass] unknown argument: ${a}`);
    }
  }
  if (!service) {
    throw new Error(`[aqua-ctl drift-bypass] --service is required`);
  }
  if (!VALID_SERVICE_NAME.test(service)) {
    throw new Error(
      `[aqua-ctl drift-bypass] --service '${service}' must match ${VALID_SERVICE_NAME.source}`,
    );
  }
  if (!reason || reason.trim().length === 0) {
    throw new Error(
      `[aqua-ctl drift-bypass] --reason is required. Provide an incident ID, ticket URL, or short justification.`,
    );
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new Error(
      `[aqua-ctl drift-bypass] --reason exceeds ${MAX_REASON_LENGTH} chars`,
    );
  }
  if (!ttl) {
    throw new Error(
      `[aqua-ctl drift-bypass] --ttl is required. Example: --ttl 2h`,
    );
  }
  const ttlMs = parseTtl(ttl);
  const actor = resolveActor(env);
  return { service, reason, ttlMs, environment, actor, dryRun };
}

export interface BypassWriter {
  write(args: {
    service: string;
    reason: string;
    expiresAt: Date;
    actor: string;
    environment: string;
  }): Promise<{ id: string }>;
}

export async function runDriftBypass(
  args: DriftBypassArgs,
  writer: BypassWriter,
  now: Date = new Date(),
): Promise<{ id: string; dryRun: boolean }> {
  const expiresAt = new Date(now.getTime() + args.ttlMs);
  if (args.dryRun) {
    return { id: '<dry-run>', dryRun: true };
  }
  const result = await writer.write({
    service: args.service,
    reason: args.reason,
    expiresAt,
    actor: args.actor,
    environment: args.environment,
  });
  return { id: result.id, dryRun: false };
}

export function printUsage(): void {
  process.stdout.write(
    `Usage: aqua-ctl <subcommand> [...args]

Subcommands:
  drift-bypass --service <name> --reason <text> --ttl <duration>
               [--environment <env>] [--dry-run]

    Issue a SCHEMA_DRIFT_FATAL bypass for one service for up to 7
    days. Writes an audit row to observability.emergency_overrides.

  help
    Show this message.

Environment:
  GITHUB_USER / SUDO_USER / USER (required — actor attribution)
  AQUA_ENV (default 'development')
  DATABASE_URL or DATABASE_HOST/PORT/USER/PASSWORD/NAME

Exit codes: 0 success / 1 validation failure / 2 usage error
`,
  );
}

/**
 * Real writer backed by pg-driver. Lazily loaded to keep the CLI
 * test-friendly — unit tests substitute a fake writer.
 */
export async function makePgWriter(): Promise<BypassWriter> {
  // Dynamic import — `pg` may not be installed in minimal test envs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('pg') as typeof import('pg');
  const url =
    process.env['DATABASE_URL'] ??
    buildUrlFromParts(process.env);
  if (!url) {
    throw new Error(
      `[aqua-ctl] DATABASE_URL (or DATABASE_HOST+PORT+USER+PASSWORD+NAME) not set`,
    );
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  return {
    async write({ service, reason, expiresAt, actor, environment }) {
      const res = await client.query(
        `INSERT INTO observability.emergency_overrides
           (service_name, kind, reason, actor, expires_at, environment)
         VALUES ($1, 'drift_fatal_bypass', $2, $3, $4, $5)
         RETURNING id`,
        [service, reason, actor, expiresAt.toISOString(), environment],
      );
      await client.end();
      return { id: res.rows[0].id as string };
    },
  };
}

function buildUrlFromParts(env: NodeJS.ProcessEnv): string | undefined {
  const host = env['DATABASE_HOST'];
  const port = env['DATABASE_PORT'] ?? '5432';
  const user = env['DATABASE_USER'];
  const pass = env['DATABASE_PASSWORD'];
  const name = env['DATABASE_NAME'];
  if (!host || !user || !name) return undefined;
  const auth = pass ? `${user}:${encodeURIComponent(pass)}` : user;
  return `postgres://${auth}@${host}:${port}/${name}`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [subcmd, ...rest] = argv;
  if (!subcmd || subcmd === 'help' || subcmd === '--help') {
    printUsage();
    return 0;
  }
  if (subcmd === 'drift-bypass') {
    let args: DriftBypassArgs;
    try {
      args = parseDriftBypassArgs(rest);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 2;
    }
    let writer: BypassWriter;
    try {
      writer = await makePgWriter();
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 2;
    }
    try {
      const r = await runDriftBypass(args, writer);
      process.stdout.write(
        `aqua-ctl drift-bypass ${r.dryRun ? '(dry-run)' : 'written'}: ` +
          `id=${r.id} service=${args.service} actor=${args.actor} ` +
          `reason="${args.reason}" ttlMs=${args.ttlMs} env=${args.environment}\n`,
      );
      return 0;
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
  }
  process.stderr.write(`[aqua-ctl] unknown subcommand: ${subcmd}\n`);
  printUsage();
  return 2;
}

if (process.argv[1]?.endsWith('aqua-ctl.ts')) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
