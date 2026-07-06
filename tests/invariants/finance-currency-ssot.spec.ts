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
 *   - the two cross-domain handlers whose drift the finding named:
 *     `create-feeding-record.handler.ts` (was `|| 'NOK'`) and
 *     `create-employee.handler.ts` (was `|| 'USD'`).
 *
 * It bans a `|| '<ISO>'` / `?? '<ISO>'` currency fallback (from the
 * recognised-currency allowlist) in those files. The remaining
 * farm create-handlers that still carry an entity-seed currency default
 * are tracked debt (FARM-HIGH-146) — NOT yet in scope here; widening
 * GUARDED_FILES to include them is the ratchet step as each is migrated.
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

/** Named cross-domain handlers the finding explicitly de-drifted. */
const NAMED_GUARDED_FILES = [
  path.resolve(
    REPO_ROOT,
    'apps/farm-service/src/feeding/handlers/create-feeding-record.handler.ts',
  ),
  path.resolve(REPO_ROOT, 'apps/hr-service/src/hr/handlers/create-employee.handler.ts'),
];

/**
 * `|| 'USD'` / `?? "nok"` — a recognised ISO 4217 currency code used as a
 * runtime fallback. The allowlist keeps the match precise (a bare
 * `[A-Za-z]{3}` would also flag `'ASC'` sort orders and `'UTC'` zones).
 */
const CURRENCY_FALLBACK =
  /(\|\||\?\?)\s*['"](TRY|NOK|USD|EUR|GBP|SEK|DKK|CHF|JPY|CNY)['"]/gi;

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
