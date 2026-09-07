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

/** Property names that name a platform entity and therefore hold a uuid. */
const IDENTITY_PROPERTIES = new Set(['tenantId', 'userId', 'assignedTo', 'resolvedBy']);

/**
 * Actor columns, which are exempt and must stay so until they get a type that
 * fits them.
 *
 * `users.service.ts:678` writes `performedBy: 'admin-api-service'` and
 * `security-monitoring.service.ts:758` writes `createdBy: 'system'`, both
 * correctly: an audit actor may be a service, and a detector-raised incident
 * has no human author. That is not a uuid problem, it is a missing sum type —
 * an actor is `{ kind: 'user' | 'service', id }`. Forcing these into uuid would
 * mean minting a fake uuid for `'system'`, replacing an honest string with a
 * dishonest identifier.
 *
 * Tracked as ADMIN-MEDIUM-117 (owner okan, 2027-03-31) with the typed-actor
 * design named. This set is not a place to park a column somebody did not want
 * to convert: the case below fails when an entry names a column that no longer
 * exists, so the exemption cannot outlive its subject.
 */
const ACTOR_COLUMNS = new Set([
  'AuditLog.performedBy',
  'TenantActivity.performedBy',
  'SecurityIncident.createdBy',
]);

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

  it('every admin tenant-id and user-id column is a uuid', () => {
    // A varchar accepts '', a trimmed id, a truncated one, and an id from a
    // different platform. These columns hold `auth.tenants.id` and
    // `auth.users.id` and nothing else, so the type says so.
    const stringy = columns
      .filter((column) => IDENTITY_PROPERTIES.has(column.property))
      .filter((column) => !ACTOR_COLUMNS.has(`${column.entity}.${column.property}`))
      .filter((column) => !/type:\s*'uuid'/.test(column.options))
      .map(
        (column) =>
          `${column.file}: ${column.entity}.${column.property} — @${column.decorator}(${column.options})`,
      );
    expect(stringy).toEqual([]);
  });

  it('no uuid column carries a length', () => {
    // `length` on a uuid is meaningless to Postgres and reads as a varchar the
    // author forgot to finish converting — it is drift wearing the right type.
    const withLength = columns
      .filter((column) => /type:\s*'uuid'/.test(column.options) && /\blength:/.test(column.options))
      .map((column) => `${column.file}: ${column.entity}.${column.property}`);
    expect(withLength).toEqual([]);
  });

  it('the actor-column exemption names only columns that still exist', () => {
    // An exemption for a column nobody declares any more is a waiver with no
    // subject, and it hides the day the column comes back as a uuid.
    const declared = new Set(columns.map((column) => `${column.entity}.${column.property}`));
    const stale = [...ACTOR_COLUMNS].filter((entry) => !declared.has(entry));
    expect(stale).toEqual([]);
  });

  it('every admin IP column is inet', () => {
    // `varchar(45)` is the length of the longest IPv6 text form — the column
    // was sized for an address and then typed as text, so it accepts anything
    // that fits. It held the word "unknown". `inet` validates on write,
    // normalises `::ffff:192.0.2.1`, sorts correctly and supports the subnet
    // operators any real "is this in the attacker's range" query needs.
    const stringy = columns
      .filter((column) => /^(ipAddress|clientIp)$/.test(column.property))
      .filter((column) => !/type:\s*'inet'/.test(column.options))
      .map(
        (column) =>
          `${column.file}: ${column.entity}.${column.property} — @${column.decorator}(${column.options})`,
      );
    expect(stringy).toEqual([]);
  });

  it('nothing writes a placeholder into an IP column', () => {
    // The W5 projection wrote `event.ip ?? 'unknown'`, which an inet column
    // rejects and a varchar keeps forever while every equality query silently
    // fails to match it. An absent address is absent.
    const writers = listFiles('apps/admin-api-service/src/**/*.ts').filter(
      (file) => !/\.(?:spec|test)\.ts$/.test(file) && !file.includes('__tests__'),
    );
    const offenders = writers
      .filter((file) => /ipAddress:[^,;\n]*\?\?\s*'[^']+'/.test(read(file)))
      .map((file) => `${file}: writes a literal fallback into an IP column`);
    expect(offenders).toEqual([]);
  });

  it('no admin entity declares a simple-array column', () => {
    // `simple-array` is not a Postgres type. TypeORM stores the list as `text`
    // joined with commas and reads it back by splitting on commas, with no
    // escaping — so an element CONTAINING a comma becomes two elements on the
    // next read, silently and permanently. These columns hold typed-in values
    // (`affectedSystems`, `threatTypes`, `dataCategories`, `tags`), which is
    // exactly where a comma appears.
    const joined = columns
      .filter((column) => /type:\s*'simple-array'/.test(column.options))
      .map((column) => `${column.file}: ${column.entity}.${column.property}`);
    expect(joined).toEqual([]);
  });

  it('every admin string[] column is a real array or jsonb', () => {
    // The banned type above has variants — `simple-json`, or a bare `text`
    // column with a hand-rolled join. A list is stored as a list: `text[]`
    // when the elements are scalars, `jsonb` when they are objects.
    const flattened = columns
      .filter((column) => /^(?:readonly\s+)?[A-Za-z]\w*\[\]/.test(column.tsType))
      .filter((column) => !/\barray:\s*true\b/.test(column.options))
      .filter((column) => !/(?:type:\s*)?'jsonb?'/.test(column.options))
      .map(
        (column) =>
          `${column.file}: ${column.entity}.${column.property} — @${column.decorator}(${column.options})`,
      );
    expect(flattened).toEqual([]);
  });

  it('every column filtered with the array-overlap operator is a real array column', () => {
    // `&&` has no `text` operand form. Against a `simple-array` column Postgres
    // answers `operator does not exist: text && text[]`, so the query is a 500
    // and not a filter — which is what BOTH the activity-log list and the
    // audit-trail list did whenever a caller passed `?tags=`. The predicate was
    // written against the type the column should have had; this case keeps the
    // two from drifting apart again in either direction.
    //
    // The alias is resolved to its entity rather than matched by property name:
    // four admin entities declare a `tags`, and three of them store objects in
    // jsonb quite correctly. A name-only check would call those offenders.
    const arrayByEntity = new Map<string, boolean>();
    for (const column of columns) {
      arrayByEntity.set(
        `${column.entity}.${column.property}`,
        /\barray:\s*true\b/.test(column.options),
      );
    }

    const sources = listFiles('apps/admin-api-service/src/**/*.ts').filter(
      (file) => !/\.(?:spec|test)\.ts$/.test(file) && !file.includes('__tests__'),
    );

    const offenders: string[] = [];
    let predicates = 0;
    for (const file of sources) {
      const source = read(file);

      // `private readonly xRepository: Repository<Entity>` — the field names
      // its entity in its own type, so no import graph is needed.
      const entityByField = new Map<string, string>();
      for (const match of source.matchAll(/\b(\w+):\s*Repository<(\w+)>/g)) {
        entityByField.set(match[1] as string, match[2] as string);
      }

      // `this.xRepository.createQueryBuilder('alias')` — the alias every
      // predicate in that builder is written against.
      const entityByAlias = new Map<string, string>();
      for (const match of source.matchAll(/this\.(\w+)\.createQueryBuilder\('(\w+)'\)/g)) {
        const entity = entityByField.get(match[1] as string);
        if (entity) entityByAlias.set(match[2] as string, entity);
      }

      for (const match of source.matchAll(/\b(\w+)\.(\w+)\s+&&\s+ARRAY\[/g)) {
        const entity = entityByAlias.get(match[1] as string);
        if (!entity) continue;
        predicates += 1;
        const key = `${entity}.${match[2] as string}`;
        if (arrayByEntity.get(key) === false) {
          offenders.push(`${file}: ${key} is filtered with && but is not an array column`);
        }
      }
    }

    // A refactor that renamed the builder idiom would otherwise make this case
    // pass by seeing nothing at all.
    expect(predicates).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
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
