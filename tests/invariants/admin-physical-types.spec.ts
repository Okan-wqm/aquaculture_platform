/**
 * The admin schema's physical types say what the data is (ADMIN-HIGH-012).
 *
 * A column's type is the cheapest constraint the platform has, and admin was
 * not using it: instants stored as wall-clock readings, tenant ids as free
 * text, IP addresses as `varchar(45)`.
 *
 * # Why the decorator clauses, not just the DDL ones
 *
 * `1781900000000-ConvertAuditColumnsToTimestamptz` converted the audit columns
 * across eight services in 2026. It now sits in `.archive/`, and
 * `1800000000000-Baseline` declares `"createdAt" TIMESTAMP NOT NULL DEFAULT
 * now()` — the pre-fix type. The migration corrected the DATABASE and nobody
 * corrected the ENTITIES; the decorators still said bare `@CreateDateColumn()`,
 * whose Postgres default is `timestamp`, so regenerating the baseline from
 * entity metadata regenerated the bug.
 *
 * That is the failure this file exists to make impossible. A DDL-only check
 * would have passed on the day the fix was undone, because the DDL was
 * *correct* — it was correct in a migration that a squash then replaced. The
 * ENTITY is the thing a squash reads, so the entity is what has to be pinned.
 *
 * Scope is admin-owned entities: `@Entity(..., { schema: 'admin' })`. The
 * 18 mirrors in this service (`synchronize: false` views onto `auth.*` and
 * `billing.*`) describe another service's DDL, and correcting their decorators
 * without changing that DDL would swap one drift for another.
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-012
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MIGRATIONS = 'apps/admin-api-service/src/migrations';
/** Everything at or before the squashed baseline is history, not a target. */
const BASELINE_TIMESTAMP = 1800000000000;

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

function listFiles(...globs: string[]): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...globs], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

interface AdminColumn {
  file: string;
  entity: string;
  property: string;
  decorator: string;
  options: string;
  tsType: string;
}

/**
 * Every column declared on an entity whose `@Entity` names `schema: 'admin'`.
 *
 * Split by `@Entity(...)` rather than by class so a file holding both an
 * admin-owned entity and a `synchronize: false` mirror is judged per entity —
 * `security.entity.ts` and `tenant.entity.ts` both do this.
 */
function adminColumns(): AdminColumn[] {
  const columns: AdminColumn[] = [];
  for (const file of listFiles('apps/admin-api-service/src/**/*.entity.ts')) {
    const source = read(file);
    const parts = source.split(/(@Entity\([^)]*\))/);
    let schema: string | null = null;
    let entity = '?';
    for (const part of parts) {
      if (part.startsWith('@Entity(')) {
        schema = /schema:\s*'(\w+)'/.exec(part)?.[1] ?? null;
        continue;
      }
      if (schema !== 'admin') continue;
      entity = /export class (\w+)/.exec(part)?.[1] ?? entity;
      const declaration =
        /@((?:Create|Update|Delete)DateColumn|Column|PrimaryGeneratedColumn|MoneyColumn|PercentColumn)\(([^\n]*)\)\s*\n\s*(\w+)[!?]?:\s*([^;]+);/g;
      for (const match of part.matchAll(declaration)) {
        columns.push({
          file,
          entity,
          decorator: match[1] as string,
          options: (match[2] as string).trim(),
          property: match[3] as string,
          tsType: (match[4] as string).trim(),
        });
      }
    }
  }
  return columns;
}

/** Admin migrations newer than the squashed baseline. */
function migrationsAfterBaseline(): string[] {
  return listFiles(`${MIGRATIONS}/*.ts`).filter((file) => {
    const stamp = Number(/^(\d+)-/.exec(basename(file))?.[1] ?? '0');
    return stamp > BASELINE_TIMESTAMP;
  });
}

describe('INVARIANT (ADMIN-HIGH-012): the admin schema stores instants as instants', () => {
  const columns = adminColumns();

  it('sees the admin entity surface', () => {
    // A moved directory or a renamed decorator would otherwise make every case
    // below vacuously pass.
    expect(columns.length).toBeGreaterThanOrEqual(300);
    expect(new Set(columns.map((column) => column.entity)).size).toBeGreaterThanOrEqual(30);
  });

  it('no admin entity uses a bare @CreateDateColumn / @UpdateDateColumn / @DeleteDateColumn', () => {
    // The Postgres driver's default for these is `timestamp` — a wall-clock
    // reading with no origin. This is the exact declaration that let the 2026
    // conversion be undone by a baseline regeneration.
    const bare = columns
      .filter((column) => /DateColumn$/.test(column.decorator) && column.options === '')
      .map((column) => `${column.file}: ${column.entity}.${column.property}`);
    expect(bare).toEqual([]);
  });

  it('every admin Date column declares its type explicitly', () => {
    // `timestamptz` for an instant; `'date'` for a calendar day, which is a
    // different thing and has to say so. An undeclared type is the driver's
    // choice, and the driver chooses wrong.
    const implicit = columns
      .filter((column) => /^Date\b/.test(column.tsType))
      .filter(
        (column) => !/type:\s*'(timestamptz|timestamp with time zone|date)'/.test(column.options),
      )
      .map(
        (column) =>
          `${column.file}: ${column.entity}.${column.property} — @${column.decorator}(${column.options})`,
      );
    expect(implicit).toEqual([]);
  });

  it('no admin Date column is declared as a naked timestamp', () => {
    const naked = columns
      .filter((column) => /type:\s*'timestamp'/.test(column.options))
      .map((column) => `${column.file}: ${column.entity}.${column.property}`);
    expect(naked).toEqual([]);
  });

  it('no admin migration after the baseline creates a naked TIMESTAMP column', () => {
    // The baseline itself is history and is corrected forward by
    // `1809600000000-AdminSchemaTimestamptz`; hand-editing a migration is
    // forbidden. What must not happen is a NEW one reintroducing the type.
    const offenders: string[] = [];
    for (const file of migrationsAfterBaseline()) {
      // Comments stripped first: a docblock QUOTING the defect (this one does)
      // is documentation, not DDL. And only the forward half is judged — a
      // reverse step legitimately restores whatever it dropped.
      const source = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const down = source.indexOf('public async down(');
      const up = down === -1 ? source : source.slice(0, down);
      for (const match of up.matchAll(/"(\w+)"\s+TIMESTAMP(?!\s*(?:WITH TIME ZONE|TZ))\b/gi)) {
        offenders.push(
          `${file}: column "${match[1] as string}" declared TIMESTAMP without time zone`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
