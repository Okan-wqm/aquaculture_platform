/**
 * INVARIANT — every scheduled method in the fleet is leased and heartbeated
 * (ADMIN-HIGH-013).
 *
 * `@Cron` / `@Interval` / `@Timeout` fire on every replica: two admin-api
 * pods ran every sweep twice and nothing recorded that a tick happened. The
 * kernel `@ScheduledJob({ name, cron | every })` decorator is the only
 * sanctioned schedule: it applies the NestJS decorator itself and routes the
 * body through `ScheduledJobRunner` (a per-(service, job) Postgres advisory
 * lock plus `CronHeartbeatService`), and it does not compile on a class that
 * lacks the runner. This gate keeps the raw decorators out of the tree.
 *
 *   1. Every scheduled method uses `@ScheduledJob`, or is a raw site listed
 *      in `.claude/allowlists/unleased-scheduled-jobs.yaml` with owner, future
 *      expiry, findingId and reason, under a ceiling that only decreases. An
 *      entry whose site is gone or converted fails: the list only shrinks.
 *      admin-api (the finding's surface) has no entries.
 *   2. `@ScheduledJob` names are literal, well-formed and unique per project —
 *      a duplicated name would share one lock and one heartbeat series.
 *   3. A service that declares `@ScheduledJob` registers
 *      `ScheduledJobModule.forRoot({ serviceName })` in its module tree.
 *   4. `CronHeartbeatService` is reached only through the runner: direct
 *      `track(...)` callers outside the kernel are listed in the same
 *      allowlist (`directHeartbeatFiles`), and that list only shrinks too.
 *
 * The scan is `tests/invariants/lib/scheduled-method-table.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as yaml from 'js-yaml';

import {
  REPO_ROOT,
  allScheduledMethods,
  listScheduledSourceFiles,
  type ScheduledMethod,
} from './lib/scheduled-method-table';

const ALLOWLIST = '.claude/allowlists/unleased-scheduled-jobs.yaml';
const JOB_NAME = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

/** Kernel files that legitimately name CronHeartbeatService. */
const HEARTBEAT_KERNEL_FILES: ReadonlySet<string> = new Set([
  'libs/backend-common/src/metrics/cron-heartbeat.service.ts',
  'libs/backend-common/src/metrics/metrics.module.ts',
  'libs/backend-common/src/metrics/index.ts',
  'libs/backend-common/src/scheduling/scheduled-job-runner.service.ts',
]);

interface AllowlistEntry {
  site: string;
  owner: string;
  expiry: string | Date;
  findingId: string;
  reason: string;
}

interface Allowlist {
  version?: number;
  ceiling?: number;
  entries?: AllowlistEntry[];
  directHeartbeatFiles?: AllowlistEntry[];
}

function readAllowlist(): Required<Allowlist> {
  const doc = yaml.load(readFileSync(resolve(REPO_ROOT, ALLOWLIST), 'utf8')) as Allowlist;
  return {
    version: doc.version ?? 1,
    ceiling: doc.ceiling ?? 0,
    entries: doc.entries ?? [],
    directHeartbeatFiles: doc.directHeartbeatFiles ?? [],
  };
}

/** A docstring that names the heartbeat is not a dependency on it. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

function expiryIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

function moduleFilesOf(project: string): string[] {
  return execFileSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'ls-files',
      '--',
      `${project}/src/*.module.ts`,
      `${project}/src/**/*.module.ts`,
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

describe('INVARIANT (ADMIN-HIGH-013): every scheduled method is leased and heartbeated', () => {
  const methods = allScheduledMethods();
  const raw = methods.filter((m) => m.decorator !== 'ScheduledJob');
  const leased = methods.filter((m) => m.decorator === 'ScheduledJob');
  const allowlist = readAllowlist();
  const today = new Date().toISOString().slice(0, 10);
  const allowedSites = new Set(allowlist.entries.map((e) => e.site));

  it('sees the fleet', () => {
    // A floor, not a ratchet: it exists so a rename that breaks the parser
    // cannot make every case below vacuously pass. 20 since ADMIN-HIGH-014
    // retired `sessions.cleanup-expired`, an hourly job that expired rows in
    // `admin.user_sessions` — a table no code ever inserted into. W7 raises
    // this number as the fleet's 67 raw @Cron sites convert.
    expect(methods.length).toBeGreaterThan(50);
    expect(leased.length).toBeGreaterThanOrEqual(20);
  });

  it('has no raw @Cron / @Interval / @Timeout outside the governed ratchet', () => {
    const offenders = raw
      .map((m) => m.id)
      .filter((id) => !allowedSites.has(id))
      .sort();
    expect(offenders).toEqual([]);
  });

  it('keeps the ratchet honest — every entry names a live raw site, is governed, and the list only shrinks', () => {
    const rawIds = new Set(raw.map((m) => m.id));
    for (const entry of allowlist.entries) {
      expect(rawIds.has(entry.site)).toBe(true);
      expect(entry.owner.trim().length).toBeGreaterThan(0);
      expect(entry.findingId).toMatch(/^[A-Z]+-(CRITICAL|HIGH|MEDIUM|LOW)-\d{3}$/);
      expect(entry.reason.trim().length).toBeGreaterThan(20);
      expect(expiryIso(entry.expiry) >= today).toBe(true);
    }
    expect(allowlist.entries.length).toBeLessThanOrEqual(allowlist.ceiling);
    expect(new Set(allowlist.entries.map((e) => e.site)).size).toBe(allowlist.entries.length);
  });

  it('admin-api schedules nothing raw', () => {
    expect(raw.filter((m) => m.project === 'apps/admin-api-service').map((m) => m.id)).toEqual([]);
    expect(allowlist.entries.filter((e) => e.site.startsWith('apps/admin-api-service/'))).toEqual(
      [],
    );
  });

  it('names every @ScheduledJob with a literal, well-formed name, unique within its project', () => {
    const problems: string[] = [];
    const seen = new Map<string, ScheduledMethod>();
    for (const m of leased) {
      if (m.jobName === null) {
        problems.push(`${m.id}: @ScheduledJob name must be a string literal`);
        continue;
      }
      if (!JOB_NAME.test(m.jobName)) {
        problems.push(
          `${m.id}: '${m.jobName}' is not a job name (lower-case words joined by '-' or '.')`,
        );
      }
      const key = `${m.project}:${m.jobName}`;
      const other = seen.get(key);
      if (other) problems.push(`${m.id} and ${other.id} both declare '${m.jobName}'`);
      seen.set(key, m);
    }
    expect(problems).toEqual([]);
  });

  it('registers ScheduledJobModule.forRoot in every service that declares a @ScheduledJob', () => {
    const projects = new Set(
      leased.filter((m) => m.project.startsWith('apps/')).map((m) => m.project),
    );
    const missing = [...projects].filter(
      (project) =>
        !moduleFilesOf(project).some((file) =>
          /ScheduledJobModule\.forRoot\(/.test(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
        ),
    );
    expect(missing).toEqual([]);
  });

  it('reaches CronHeartbeatService only through the runner (direct callers are ratcheted)', () => {
    const allowedFiles = new Set(allowlist.directHeartbeatFiles.map((e) => e.site));
    const direct = listScheduledSourceFiles()
      .filter((rel) => !HEARTBEAT_KERNEL_FILES.has(rel))
      .filter((rel) =>
        /\bCronHeartbeatService\b/.test(
          stripComments(readFileSync(resolve(REPO_ROOT, rel), 'utf8')),
        ),
      )
      .sort();
    expect(direct.filter((rel) => !allowedFiles.has(rel))).toEqual([]);
    for (const entry of allowlist.directHeartbeatFiles) {
      expect(direct).toContain(entry.site);
      expect(expiryIso(entry.expiry) >= today).toBe(true);
      expect(entry.findingId).toMatch(/^[A-Z]+-(CRITICAL|HIGH|MEDIUM|LOW)-\d{3}$/);
    }
  });
});
