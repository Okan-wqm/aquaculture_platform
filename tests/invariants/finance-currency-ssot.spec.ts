/**
 * Finance currency SSoT invariant (FARM-MEDIUM-145).
 * ============================================================================
 *
 * The tenant default currency has exactly ONE source of truth:
 *   - farm-service: `finance_settings.defaultCurrency`, resolved through
 *     `FinanceSettingsService`;
 *   - hr-service: `hr_payroll_cost_settings.defaultCurrency`, resolved
 *     through `PayrollCostSettingsService` (itself projected from the
 *     farm SSoT via the `FinanceSettingsUpdated` event).
 *
 * The bug this freezes: three independent hardcoded ISO-currency
 * literals had drifted — `feeds`/`equipment` entities defaulted to
 * `'TRY'`, `create-feeding-record.handler.ts` to `'NOK'`, and the HR
 * `employee.entity.ts` to `'USD'` — so a tenant recording feed in one
 * form and equipment in another silently booked in different currencies.
 *
 * # Scope
 *
 * This invariant guards the currency-writing paths that have been
 * migrated to the settings SSoT and MUST stay migrated:
 *   - every command handler under a `finance/` domain (the finance
 *     ledgers themselves), and
 *   - the cross-domain create-handlers that seed an entity currency:
 *     `create-feeding-record` (was `|| 'NOK'`), HR `create-employee`
 *     (was `|| 'USD'`), and — closing FARM-HIGH-146 — the eight further
 *     farm create-handlers that seeded a `'TRY'`/`'NOK'` literal:
 *     `create-batch`, `create-cleaner-batch`, `create-chemical`,
 *     `create-consumable`, `create-equipment`, `create-feed`,
 *     `add-feed-inventory`, and `create-purchase-order`.
 *
 * It bans a `|| '<ISO>'` / `?? '<ISO>'` currency fallback (from the
 * recognised-currency allowlist) in those files. FARM-HIGH-146 is now
 * CLOSED: every farm/HR create-handler that seeds an entity currency
 * resolves the tenant default through `FinanceSettingsService`
 * (`getDefaultCurrency` / `getDefaultCurrencyInTx`) — there is no longer
 * a hardcoded-currency create-handler outside this guarded set.
 *
 * # When this spec fails
 *
 *   A guarded handler reintroduces a `|| 'XXX'` / `?? 'XXX'` currency
 *   fallback. Resolve currency through
 *   `FinanceSettingsService.getDefaultCurrencyInTx(...)` /
 *   `PayrollCostSettingsService.getDefaultCurrencyInTx(...)` instead.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Finance-domain handler roots — every command handler here is guarded. */
const FINANCE_HANDLER_ROOTS = [
  path.resolve(REPO_ROOT, 'apps/farm-service/src/finance'),
  path.resolve(REPO_ROOT, 'apps/hr-service/src/finance'),
];

/**
 * Named cross-domain create-handlers that seed an entity currency and
 * MUST resolve it through the settings SSoT. The first two are the
 * handlers FARM-MEDIUM-145 named; the rest closed FARM-HIGH-146 (every
 * farm create-handler that previously seeded a `'TRY'`/`'NOK'` literal).
 */
const NAMED_GUARDED_FILES = [
  'apps/farm-service/src/feeding/handlers/create-feeding-record.handler.ts',
  'apps/hr-service/src/hr/handlers/create-employee.handler.ts',
  // FARM-HIGH-146 — every further farm create-handler that seeded a
  // currency literal, now migrated to the settings SSoT.
  'apps/farm-service/src/batch/handlers/create-batch.handler.ts',
  'apps/farm-service/src/batch/handlers/create-cleaner-batch.handler.ts',
  'apps/farm-service/src/chemical/handlers/create-chemical.handler.ts',
  'apps/farm-service/src/consumable/handlers/create-consumable.handler.ts',
  'apps/farm-service/src/equipment/handlers/create-equipment.handler.ts',
  'apps/farm-service/src/feed/handlers/create-feed.handler.ts',
  'apps/farm-service/src/feeding/handlers/add-feed-inventory.handler.ts',
  'apps/farm-service/src/storage/handlers/create-purchase-order.handler.ts',
  'apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts',
  'apps/farm-service/src/worker/handlers/create-worker.handler.ts',
].map((rel) => path.resolve(REPO_ROOT, rel));

/**
 * A recognised ISO 4217 currency code hardcoded in a currency-writing
 * path, in either shape:
 *   - a fallback:      `|| 'USD'` / `?? "nok"`
 *   - a direct assign: `currency: 'TRY'` (the bare form used by the
 *     purchase-order / harvest / worker handlers before FARM-HIGH-146).
 * The allowlist keeps the match precise (a bare `[A-Za-z]{3}` would also
 * flag `'ASC'` sort orders and `'UTC'` zones).
 */
const CURRENCY_FALLBACK =
  /(?:(?:\|\||\?\?)\s*|currency:\s*)['"](TRY|NOK|USD|EUR|GBP|SEK|DKK|CHF|JPY|CNY)['"]/gi;

function listHandlerFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__') continue;
        walk(full);
      } else if (/\.handler\.ts$/.test(entry) && !entry.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

describe('Finance currency SSoT invariant (FARM-MEDIUM-145)', () => {
  const guardedFiles = [
    ...FINANCE_HANDLER_ROOTS.flatMap(listHandlerFiles),
    ...NAMED_GUARDED_FILES,
  ];

  it('finds the guarded handler set (extractor sanity)', () => {
    // The finance domains ship entry + category + settings handlers on both
    // services, plus the two named cross-domain handlers.
    expect(guardedFiles.length).toBeGreaterThanOrEqual(8);
  });

  it('no guarded handler hardcodes a currency fallback literal', () => {
    const offenders: string[] = [];
    for (const file of guardedFiles) {
      const source = readFileSync(file, 'utf8');
      const matches = source.match(CURRENCY_FALLBACK);
      if (matches) {
        offenders.push(
          `${path.relative(REPO_ROOT, file)} → ${[...new Set(matches)].join(', ')}`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });
});
