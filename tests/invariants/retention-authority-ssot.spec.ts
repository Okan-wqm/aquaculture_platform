/**
 * One retention authority, entity-typed, with no unbounded streams (ADR-0012).
 *
 * Three engines disposed of admin-api's data until 2026-09-05. The canonical
 * registry named its columns as strings and got `created_at` wrong for
 * `"createdAt"`, so the SOC 2 windows never ran; a runtime-editable engine
 * deleted `activity_logs` with no legal hold; eight services carried their
 * own `@Cron` disposal. This spec makes each of those shapes a build
 * failure:
 *
 *   1. No scheduled method in any service disposes rows by age. The kernel
 *      `RetentionEnforcementService` is the only cron that does. The few
 *      disposers the cross-tenant registry cannot serve yet (per-tenant
 *      tables, the outbox GC) are carried in
 *      `.claude/allowlists/unbounded-tables.yaml#scheduledDisposers` with an
 *      owner, an expiry and a finding, under a ceiling that only decreases.
 *   2. Every registration is entity-typed — `entity:` + `timestampProperty:`,
 *      never a table or column string — so the compiler and the ORM metadata
 *      check the binding, not a reviewer.
 *   3. Every append-only stream table in the admin, shared and observability
 *      schemas is bound to a policy or carried on the allowlist with owner,
 *      expiry, finding and reason; an expired entry fails.
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#DATA-CRITICAL-013
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ENFORCER = 'libs/backend-common/src/database/retention/retention-enforcement.service.ts';
const ALLOWLIST = join(REPO_ROOT, '.claude/allowlists/unbounded-tables.yaml');
const STREAM_TABLE_RE =
  /_(?:logs|events|metrics|snapshots|occurrences|attempts|sessions|history|calls|queries)$/;
const JUDGED_SCHEMAS = new Set(['admin', 'shared', 'observability']);
const ENTITY_ROOTS = [
  'apps/admin-api-service/src',
  'apps/observability-service/src',
  'libs/backend-common/src',
];
/** The ceiling only decreases: a new disposer outside the kernel is a build failure. */
const MAX_SCHEDULED_DISPOSERS = 4;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.archive', '__tests__', 'coverage'].includes(entry.name))
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !/\.(?:spec|test)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return relative(REPO_ROOT, file);
}

/** Bodies of every @Cron / @Interval / @Timeout method in a source file. */
function scheduledMethodBodies(source: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(/@(?:Cron|Interval|Timeout)\(/g)) {
    const start = match.index ?? 0;
    // A method at class-member indentation ends at the first "\n  }\n".
    const end = source.indexOf('\n  }\n', start);
    bodies.push(source.slice(start, end === -1 ? undefined : end));
  }
  return bodies;
}

interface GovernedEntry {
  owner: string;
  /** js-yaml parses an unquoted YYYY-MM-DD as a Date; both forms are accepted. */
  expiry: string | Date;
  findingId: string;
  reason: string;
}
interface AllowlistEntry extends GovernedEntry {
  table: string;
}
interface DisposerEntry extends GovernedEntry {
  file: string;
}

function allowlistDocument(): { entries: AllowlistEntry[]; scheduledDisposers: DisposerEntry[] } {
  const doc = yaml.load(readFileSync(ALLOWLIST, 'utf8')) as {
    entries?: AllowlistEntry[];
    scheduledDisposers?: DisposerEntry[];
  };
  return { entries: doc.entries ?? [], scheduledDisposers: doc.scheduledDisposers ?? [] };
}

function expiryDate(entry: GovernedEntry): string {
  return entry.expiry instanceof Date
    ? entry.expiry.toISOString().slice(0, 10)
    : String(entry.expiry);
}

/** Governance problems for one entry: missing keys, malformed or past expiry. */
function governanceProblems(entry: GovernedEntry, label: string, today: string): string[] {
  const problems: string[] = [];
  for (const key of ['owner', 'findingId', 'reason'] as const) {
    if (typeof entry[key] !== 'string' || entry[key].trim() === '') {
      problems.push(`${label}: missing ${key}`);
    }
  }
  const expiry = expiryDate(entry);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) problems.push(`${label}: expiry is not YYYY-MM-DD`);
  else if (expiry <= today) problems.push(`${label}: expired on ${expiry}`);
  return problems;
}

describe('retention has one authority (ADR-0012)', () => {
  const sources = ['apps', 'libs', 'platform/libs'].flatMap((root) => walk(join(REPO_ROOT, root)));
  const today = new Date().toISOString().slice(0, 10);

  it('no scheduled method in any service disposes rows by age — the kernel enforcer is the only cron that deletes', () => {
    const { scheduledDisposers } = allowlistDocument();
    expect(scheduledDisposers.length).toBeLessThanOrEqual(MAX_SCHEDULED_DISPOSERS);
    expect(scheduledDisposers.flatMap((d) => governanceProblems(d, d.file, today))).toEqual([]);
    const tolerated = new Set(scheduledDisposers.map((d) => d.file));

    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const file of sources) {
      if (rel(file) === ENFORCER) continue;
      for (const body of scheduledMethodBodies(readFileSync(file, 'utf8'))) {
        const disposes =
          /\bDELETE\s+FROM\b/i.test(body) ||
          (/\.delete\(/.test(body) && /\bLessThan\(|\bcutoff\b|\bretentionDays\b/.test(body)) ||
          /\.createQueryBuilder\([^)]*\)\s*\.delete\(/.test(body);
        if (disposes) {
          seen.add(rel(file));
          if (!tolerated.has(rel(file))) offenders.push(rel(file));
        }
      }
    }
    expect(offenders).toEqual([]);
    // A tolerated disposer that no longer disposes is a stale entry: remove it.
    expect([...tolerated].filter((file) => !seen.has(file))).toEqual([]);
  });

  it('every registration is entity-typed — no table or column strings reach the enforcer', () => {
    const stringy: string[] = [];
    let registrations = 0;
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/registerRetentionPolicy(?:<[^>]*>)?\(\{/g)) {
        registrations += 1;
        const block = source.slice(match.index, source.indexOf('});', match.index));
        if (!/\bentity:\s*[A-Z]\w*/.test(block) || !/\btimestampProperty:\s*'/.test(block)) {
          stringy.push(`${rel(file)}: registration without entity/timestampProperty`);
        }
        if (/\btableName:|\btimestampColumn:|\bschema:\s*'/.test(block)) {
          stringy.push(`${rel(file)}: registration names a table/column as a string`);
        }
      }
    }
    expect(registrations).toBeGreaterThanOrEqual(15);
    expect(stringy).toEqual([]);
  });

  it('every append-only stream table is bound to a policy or carried on the allowlist with an unexpired owner', () => {
    const boundEntities = new Set<string>();
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(
        /registerRetentionPolicy(?:<[^>]*>)?\(\{[\s\S]*?entity:\s*([A-Z]\w*)/g,
      )) {
        boundEntities.add(match[1] as string);
      }
    }

    const streamTables: { table: string; entity: string }[] = [];
    const entityRe =
      /@Entity\('([a-z_]+)',\s*\{\s*schema:\s*'([a-z_]+)'\s*\}\)[\s\S]*?export class (\w+)/g;
    for (const root of ENTITY_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        for (const match of readFileSync(file, 'utf8').matchAll(entityRe)) {
          const table = match[1] as string;
          const schema = match[2] as string;
          const entity = match[3] as string;
          if (JUDGED_SCHEMAS.has(schema) && STREAM_TABLE_RE.test(table)) {
            streamTables.push({ table: `${schema}.${table}`, entity });
          }
        }
      }
    }
    expect(streamTables.length).toBeGreaterThanOrEqual(10);

    const { entries } = allowlistDocument();
    const problems = entries.flatMap((entry) =>
      typeof entry.table === 'string' && entry.table.trim() !== ''
        ? governanceProblems(entry, entry.table, today)
        : ['allowlist entry without a table'],
    );
    const allowed = new Set(entries.map((entry) => entry.table));
    const unbounded = streamTables
      .filter(({ entity, table }) => !boundEntities.has(entity) && !allowed.has(table))
      .map(({ table }) => table);
    const stale = [...allowed].filter((table) => !streamTables.some((row) => row.table === table));

    expect(problems).toEqual([]);
    expect(unbounded).toEqual([]);
    expect(stale).toEqual([]);
  });
});
