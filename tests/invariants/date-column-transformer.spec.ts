/**
 * Platform-wide invariant — FARM-CRITICAL-406 date-column serialization discipline.
 *
 * PostgreSQL returns `date` columns as plain strings (`"2026-10-10"`). When
 * such a column is declared with a `Date` TypeScript type and exposed through
 * a GraphQL `DateTime` field, the apollo scalar refuses to serialize the
 * hydrated string and every read selecting the column dies with
 * `Expected DateTime.serialize(...) to return non-nullable value, returned:
 * null` — while writes keep working because their payloads carry in-memory
 * Date objects. That read/write asymmetry kept the break invisible until an
 * end-to-end exercise of the Feeding Records, Harvest, Storage inventory and
 * Task surfaces (2026-10-10 farm E2E campaign).
 *
 * RULE: every `@Column({ type: 'date' })` whose property type is `Date` MUST
 * declare `transformer: new DateColumnTransformer()` (or the shared
 * `dateColumnTransformer` instance) from `@aquaculture/backend-common/database`.
 *
 * Columns typed as `string` are deliberate pass-throughs (e.g. lot identity
 * labels) and are exempt.
 *
 * # LEGACY ALLOWLIST
 *
 * 0 pre-existing columns (farm/hr/billing/admin) predate the transformer and
 * are swept under tracked finding FARM-MEDIUM-424 (each entry must be
 * verified for string-format dependencies before transforming). The allowlist
 * exists so NEW columns cannot regress — adding a Date-typed date column
 * without the transformer fails this spec unless the file:property pair is
 * consciously appended here.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const APPS_DIR = join(REPO_ROOT, 'apps');

/** file path (from repo root) : property — awaiting the FARM-MEDIUM-424 conversion. */
const LEGACY_UNTRANSFORMED = new Set<string>([]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.entity.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Matches a `type: 'date'` @Column decorator plus the property it annotates. */
const DATE_COLUMN_RE =
  /@Column\(\{[^}]*type:\s*'date'[^}]*\}\)\s*\n\s*(?:@\w+(?:\([^)]*\))?\s*\n\s*)*(\w+)(\?)?!\s*:\s*([^;]+);/g;

interface Violation {
  file: string;
  property: string;
  line: number;
}

describe('date-column transformer invariant (FARM-CRITICAL-406)', () => {
  const violations: Violation[] = [];
  let scannedColumns = 0;

  beforeAll(() => {
    for (const file of walk(APPS_DIR)) {
      const source = readFileSync(file, 'utf8');
      DATE_COLUMN_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = DATE_COLUMN_RE.exec(source)) !== null) {
        const decoratorStart = source.lastIndexOf('@Column', match.index);
        const decorator = source.slice(decoratorStart, match.index + match[0].length);
        const propertyType = (match[3] ?? '').trim();
        scannedColumns += 1;
        if (propertyType === 'Date' && !decorator.includes('DateColumnTransformer')) {
          violations.push({
            file: relative(REPO_ROOT, file),
            property: match[1] ?? '',
            line: source.slice(0, decoratorStart).split('\n').length,
          });
        }
      }
    }
  });

  it('every Date-typed date column carries the DateColumnTransformer', () => {
    const fresh = violations.filter((v) => !LEGACY_UNTRANSFORMED.has(`${v.file}:${v.property}`));
    const stale = [...LEGACY_UNTRANSFORMED].filter(
      (entry) => !violations.some((v) => `${v.file}:${v.property}` === entry),
    );
    // fresh violations must gain the transformer; stale allowlist entries must
    // be removed once converted (FARM-MEDIUM-424).
    expect({ freshViolations: fresh, allowlistEntriesNoLongerMatching: stale }).toEqual({
      freshViolations: [],
      allowlistEntriesNoLongerMatching: [],
    });
  });

  it('the scan actually exercised date columns (guard against a rotting regex)', () => {
    expect(scannedColumns).toBeGreaterThan(20);
  });
});
