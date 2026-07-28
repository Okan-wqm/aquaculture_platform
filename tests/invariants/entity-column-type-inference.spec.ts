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

interface Offender {
  file: string;
  property: string;
  tsType: string;
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
function scan(files: readonly string[]): Offender[] {
  const offenders: Offender[] = [];
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    COLUMN_WITH_OPTIONS.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COLUMN_WITH_OPTIONS.exec(source)) !== null) {
      const options = match[1] ?? '';
      const property = match[2] ?? '';
      const tsType = (match[3] ?? '').trim();
      if (!tsType.includes('|')) continue;
      if (/\btype\s*:/.test(options)) continue;
      offenders.push({ file, property, tsType });
    }
  }
  return offenders;
}

describe('INVARIANT: entity column type inference', () => {
  const files = entityFiles();

  it('scans a real corpus (a broken glob must not fake a pass)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('apps/farm-service/src/site/entities/site.entity.ts');
  });

  it('declares an explicit column type wherever the property type is a union', () => {
    const offenders = scan(files).map(
      (o) => `${o.file} → ${o.property}: ${o.tsType} (add an explicit \`type:\`)`,
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
