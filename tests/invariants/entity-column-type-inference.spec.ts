/**
 * INVARIANT: an `@Column` whose TypeScript type is a UNION must declare `type:`
 * explicitly.
 *
 * ## Why
 *
 * TypeScript emits `design:type` metadata per property, and for a union it emits
 * `Object` — there is no single runtime class to name. When a `@Column` gives no
 * explicit `type:`, TypeORM adopts that reflected value, and building the entity
 * metadata dies with:
 *
 *   DataTypeNotSupportedError: Data type "Object" in "<Entity>.<prop>" is not
 *   supported by "postgres" database.
 *
 * That is not a narrow failure. Metadata is built for the WHOLE DataSource, so a
 * single offending column takes the entire service down before a query is ever
 * issued — on 2026-07-27 `Site.timezone: string | null` failed the fresh-volume
 * bootstrap 70 tests out of 70, meaning a clean deploy could not run
 * farm-service's migration chain at all.
 *
 * ## Why a gate rather than "we fixed it"
 *
 * Every cheap check passes: `tsc` is happy (the types are consistent), ESLint is
 * happy, and every unit suite is happy because they mock the repository layer
 * and never build metadata. The failure appears only where a real DataSource
 * initialises, which is exactly the lane that had no CI runner until this
 * program wired it up. So the defect is invisible by construction, which makes
 * it a tier-3 obligation.
 *
 * Nullable columns written `prop?: string` are unaffected — their `design:type`
 * is `String`. The union form is used deliberately when NULL carries meaning
 * (`Site.timezone`: NULL = inherit the tenant zone), so the rule is "declare the
 * type", not "avoid unions".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * `@Column({...})` immediately followed by its property declaration. Only the
 * object-literal form can omit `type:`; `@Column('varchar', {...})` and
 * `@Column(() => X)` state it positionally and are matched out by the shape.
 */
const COLUMN_WITH_OPTIONS =
  /@Column\(\{([^}]*)\}\)\s*(?:@[\w.]+\([^)]*\)\s*)*\n?\s*(\w+)!?\??:\s*([^;]+);/g;

/**
 * `@Field()` / `@Field({...})` — the forms with NO type thunk — followed by its
 * property. `@Field(() => X)` states the type and is matched out by the shape.
 *
 * Same root cause, different framework: NestJS GraphQL also falls back to
 * `design:type`, so a union property makes SDL emission fail with
 * "Undefined type error. Make sure you are providing an explicit type for …".
 * That aborts the subgraph, which aborts supergraph composition, which aborts
 * codegen — `FeedingDayPlan.growthApplicationMode` (`'per_meal' | 'daily'`) took
 * the entire farm schema build down that way.
 */
const FIELD_WITHOUT_TYPE =
  /@Field\((?:\{[^}]*\})?\)\s*(?:@[\w.]+\((?:[^()]|\([^()]*\))*\)\s*)*\n?\s*(\w+)!?\??:\s*([^;]+);/g;

interface Offender {
  file: string;
  property: string;
  tsType: string;
}

/**
 * `export type X = 'a' | 'b'` aliases across the scanned corpus.
 *
 * Resolving these is not optional. The defect that motivated this gate,
 * `FeedingDayPlan.growthApplicationMode`, is declared as the ALIAS
 * `GrowthApplicationMode`, not as an inline union — a scanner that only looks
 * for a literal `|` in the property type sees nothing and passes, which is
 * exactly the theatre this file exists to prevent. Verified by restoring the
 * broken decorator and confirming the alias-aware scan flags it.
 */
function stringLiteralUnionAliases(files: readonly string[]): Set<string> {
  const aliases = new Set<string>();
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const match of source.matchAll(/export\s+type\s+(\w+)\s*=\s*([^;]+);/g)) {
      const name = match[1];
      const body = match[2] ?? '';
      if (!name || !body.includes('|')) continue;
      if (!/['"]/.test(body)) continue; // union of TYPES, not of literal values
      aliases.add(name);
    }
  }
  return aliases;
}

/** Base type with nullability stripped: `A | null` → `A`. */
function baseTypeOf(tsType: string): string {
  const members = tsType
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== 'null' && part !== 'undefined');
  return members.length === 1 ? (members[0] ?? '') : '';
}

/** Does this property type carry no single inferable runtime class? */
function isUninferable(tsType: string, aliases: ReadonlySet<string>): boolean {
  const base = baseTypeOf(tsType);
  if (base === '') return true; // a genuine value union, inline
  return aliases.has(base);
}

function entityFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', 'apps/**/*.entity.ts', 'libs/**/*.entity.ts', 'platform/**/*.entity.ts'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Columns whose declared TS type is a union but whose options omit `type:`. */
function scanColumns(files: readonly string[], aliases: ReadonlySet<string>): Offender[] {
  const offenders: Offender[] = [];
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    COLUMN_WITH_OPTIONS.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COLUMN_WITH_OPTIONS.exec(source)) !== null) {
      const options = match[1] ?? '';
      const property = match[2] ?? '';
      const tsType = (match[3] ?? '').trim();
      if (/\btype\s*:/.test(options)) continue;
      if (!isUninferable(tsType, aliases)) continue;
      offenders.push({ file, property, tsType });
    }
  }
  return offenders;
}

/** GraphQL fields whose declared TS type is a union but which state no type. */
function scanFields(files: readonly string[], aliases: ReadonlySet<string>): Offender[] {
  const offenders: Offender[] = [];
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    FIELD_WITHOUT_TYPE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FIELD_WITHOUT_TYPE.exec(source)) !== null) {
      const property = match[1] ?? '';
      const tsType = (match[2] ?? '').trim();
      // `T | null` / `T | undefined` are fine for @Field: nullability is
      // expressed separately and the base type still reflects. What breaks is a
      // union of VALUES — written inline OR hidden behind a type alias.
      if (!isUninferable(tsType, aliases)) continue;
      offenders.push({ file, property, tsType });
    }
  }
  return offenders;
}

describe('INVARIANT: entity column type inference', () => {
  const files = entityFiles();
  const aliases = stringLiteralUnionAliases(files);

  it('scans a real corpus (a broken glob must not fake a pass)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('apps/farm-service/src/site/entities/site.entity.ts');
  });

  it('declares an explicit column type wherever the property type is a union', () => {
    const offenders = scanColumns(files, aliases).map(
      (o) => `${o.file} → ${o.property}: ${o.tsType} (add an explicit \`type:\`)`,
    );

    expect(offenders).toEqual([]);
  });

  it('declares an explicit GraphQL field type wherever the property type is a value union', () => {
    const offenders = scanFields(files, aliases).map(
      (o) => `${o.file} → ${o.property}: ${o.tsType} (use \`@Field(() => …)\`)`,
    );

    expect(offenders).toEqual([]);
  });

  it('detects the shape it is meant to detect (the scanner is not vacuous)', () => {
    // Site.timezone in its pre-fix form: union type, options without `type:`.
    const brokenFixture = `
      @Column({ length: 50, nullable: true })
      timezone!: string | null;
    `;
    COLUMN_WITH_OPTIONS.lastIndex = 0;
    const match = COLUMN_WITH_OPTIONS.exec(brokenFixture);
    expect(match).not.toBeNull();
    expect(match?.[1]).not.toMatch(/\btype\s*:/);
    expect(match?.[3]).toContain('|');

    // …and the fixed form is accepted.
    const fixedFixture = `
      @Column({ type: 'varchar', length: 50, nullable: true })
      timezone!: string | null;
    `;
    COLUMN_WITH_OPTIONS.lastIndex = 0;
    const fixed = COLUMN_WITH_OPTIONS.exec(fixedFixture);
    expect(fixed?.[1]).toMatch(/\btype\s*:/);
  });
});
