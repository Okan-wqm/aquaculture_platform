/**
 * Finance derived-source ↔ seed-category parity invariant (FARM-HIGH-144).
 * ============================================================================
 *
 * The farm finance ledger projects DERIVED costs (feed, fingerlings,
 * maintenance, treatments, harvest) at query time from their
 * source-of-truth tables via the declarative `DERIVED_COST_SOURCES`
 * registry. Each derived source books under a system finance category
 * identified by a stable `code`. If the registry references a code that
 * the default-category seed never creates, the derived rows would have
 * no category to attach to (the ledger query would silently drop or
 * mis-bucket them).
 *
 * This invariant freezes the parity: every `DERIVED_COST_SOURCES[].
 * systemCode` MUST appear as a `code` in `DEFAULT_FARM_FINANCE_CATEGORIES`.
 * Adding a new derived source without its seed category — or renaming a
 * seed code out from under the registry — fails CI before merge.
 *
 * The registry + seed modules pull in the full farm-service entity graph
 * (TypeORM decorators, etc.), which the invariants Jest project cannot
 * import. So — like the other file-reading invariants in this suite — we
 * read the two source files as TEXT and extract the code identifiers by
 * regex. That keeps the check dependency-free while still tying the two
 * SSoT lists together.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/finance/services/derived-cost-sources.ts',
);
const SEED_PATH = path.resolve(
  REPO_ROOT,
  'apps/farm-service/src/finance/services/finance-category-seed.service.ts',
);

/** `systemCode: 'FEED'` → FEED */
function extractSystemCodes(source: string): string[] {
  return Array.from(source.matchAll(/systemCode:\s*'([A-Z_]+)'/g), (m) => m[1] as string);
}

/** `{ code: 'FEED', name: ... }` → FEED */
function extractSeedCodes(source: string): string[] {
  return Array.from(source.matchAll(/\bcode:\s*'([A-Z_]+)'/g), (m) => m[1] as string);
}

describe('Finance derived-source ↔ seed-category parity (FARM-HIGH-144)', () => {
  const registrySource = readFileSync(REGISTRY_PATH, 'utf8');
  const seedSource = readFileSync(SEED_PATH, 'utf8');

  const systemCodes = extractSystemCodes(registrySource);
  const seededCodes = new Set(extractSeedCodes(seedSource));

  it('extracts a plausible number of derived sources + seed codes (extractor sanity)', () => {
    expect(systemCodes.length).toBeGreaterThanOrEqual(5);
    expect(seededCodes.size).toBeGreaterThanOrEqual(10);
  });

  it('every derived cost source books under a seeded system category', () => {
    const missing = systemCodes.filter((code) => !seededCodes.has(code));
    expect(missing).toEqual([]);
  });

  it('seeds the "other variable cost" computed category with a 5% rule', () => {
    expect(seededCodes.has('OTHER_VARIABLE')).toBe(true);
    // The computed rule literal lives in the seed source next to its code.
    expect(seedSource).toMatch(
      /computedRule:\s*\{\s*type:\s*'PERCENT_OF_SCOPE_TOTAL',\s*percent:\s*5,\s*base:\s*'NON_COMPUTED'\s*\}/,
    );
  });
});
