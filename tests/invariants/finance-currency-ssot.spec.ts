/**
 * Finance currency SSoT invariant (FARM-MEDIUM-145, FARM-HIGH-151, HR-HIGH-008).
 * ============================================================================
 *
 * The tenant default currency has exactly ONE source of truth:
 *   - farm-service: `finance_settings.defaultCurrency`, resolved through
 *     `FinanceSettingsService`;
 *   - hr-service: `hr_payroll_cost_settings.defaultCurrency`, resolved
 *     through `PayrollCostSettingsService` (itself projected from the
 *     farm SSoT via the `FinanceSettingsUpdated` event).
 *
 * The bug this freezes: independent hardcoded ISO-currency literals drift.
 * `feeds`/`equipment` defaulted to `'TRY'`, `create-feeding-record.handler.ts`
 * to `'NOK'`, HR `employee.entity.ts` to `'USD'` — so a tenant recording feed
 * in one form and equipment in another silently booked in different currencies.
 *
 * # Why this is a rule and not a list
 *
 * It used to guard `FINANCE_HANDLER_ROOTS` recursively PLUS a hardcoded
 * `NAMED_GUARDED_FILES` array, so a currency writer outside those roots was
 * covered only if somebody remembered to add it. Nobody had to: the docblock
 * claimed "there is no longer a hardcoded-currency create-handler outside this
 * guarded set" and running the spec's own pattern over every
 * `apps/**\/*.handler.ts` found SEVEN — two hr payroll handlers (HR-HIGH-008,
 * a real defect: `|| 'USD'` against a platform default of NOK, stamped onto
 * the cross-service `PayrollProcessed` event) and five billing handlers.
 * A ratchet whose coverage is a memo is not a ratchet.
 *
 * So the guard now scans EVERY handler and EVERY entity, and a currency
 * literal is a failure unless it appears in {@link DECLARED_EXEMPTIONS} with a
 * ledger finding behind it. The exemption list can only shrink: a stale entry
 * (declared but no longer matching) fails, so removing the literal forces
 * removing the entry rather than leaving a permanent hole.
 *
 * # When this spec fails
 *
 *   1. A handler or entity grew a `|| 'XXX'` / `?? 'XXX'` / `currency: 'XXX'`
 *      / `default: 'XXX'` currency literal. Resolve it through
 *      `FinanceSettingsService.getDefaultCurrencyInTx(...)` /
 *      `PayrollCostSettingsService.getDefaultCurrencyInTx(...)` instead. For a
 *      column default there is no correct literal at all — a default cannot
 *      know the tenant — so drop it and let the NOT NULL column force the
 *      writer to supply one (precedent: migration 1802200000000).
 *   2. A declared exemption no longer matches. Delete the entry; the debt it
 *      recorded is paid.
 *   3. An exemption cites a finding the ledger has RESOLVED. The finding says
 *      the work is done, so the exemption must go with it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl');

/**
 * A recognised ISO 4217 currency code hardcoded on a currency-writing path:
 *   - a fallback:       `|| 'USD'` / `?? "nok"`
 *   - a direct assign:  `currency: 'TRY'`
 *   - a column default: `default: 'USD'`
 * The allowlist keeps the match precise (a bare `[A-Za-z]{3}` would also flag
 * `'ASC'` sort orders and `'UTC'` zones).
 */
const CURRENCY_LITERAL =
  /(?:(?:\|\||\?\?)\s*|currency:\s*|default:\s*)['"](TRY|NOK|USD|EUR|GBP|SEK|DKK|CHF|JPY|CNY)['"]/gi;

/**
 * Currency literals that are allowed to remain, each with the finding that
 * tracks paying them off. NOT an exemption mechanism for new code: adding an
 * entry means registering a finding with an owner and a deadline first.
 */
const DECLARED_EXEMPTIONS: ReadonlyArray<{
  readonly file: string;
  readonly finding: string;
  readonly reason: string;
}> = [
  // BILLING-MEDIUM-016 — platform-vs-tenant currency is undeclared in billing.
  // Not asserted to be a defect: Stripe-facing platform billing in USD is a
  // defensible policy. The defect is that nothing says which reading is meant,
  // so no gate can enforce either. Declaring it is the fix; until then the
  // exemption makes the ambiguity visible instead of it being the absence of a
  // list entry.
  ...[
    'apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts',
    'apps/billing-service/src/billing/handlers/create-invoice.handler.ts',
    'apps/billing-service/src/billing/handlers/create-plan.handler.ts',
    'apps/billing-service/src/billing/handlers/create-subscription.handler.ts',
    'apps/billing-service/src/billing/query-handlers/get-tenant-billing.handler.ts',
    'apps/billing-service/src/billing/entities/custom-plan.entity.ts',
    'apps/billing-service/src/billing/entities/discount-code.entity.ts',
    'apps/billing-service/src/billing/entities/invoice.entity.ts',
    'apps/billing-service/src/billing/entities/module-price.entity.ts',
    'apps/billing-service/src/billing/entities/payment.entity.ts',
    'apps/billing-service/src/billing/entities/plan.entity.ts',
    'apps/billing-service/src/billing/entities/subscription-module-item.entity.ts',
    'apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts',
  ].map((file) => ({
    file,
    finding: 'BILLING-MEDIUM-016',
    reason: 'platform-vs-tenant billing currency is undeclared',
  })),

  // FARM-MEDIUM-327 — the handlers were migrated to the settings SSoT; the DDL
  // layer they write into was not. These columns disagree with each other
  // inside one service (TRY / NOK / USD on sibling farm tables), which is the
  // FARM-MEDIUM-145 drift one layer down. No live write reaches them because
  // every handler supplies a currency, but each is a loaded trap for a
  // backfill, an admin tool or the next writer. The fix is to drop the default
  // (a default cannot know the tenant) as migration 1802200000000 did for
  // payrolls.currency — 16 migrations across 4 services plus a NOT NULL audit,
  // which is why it is tracked rather than done inline.
  ...[
    'apps/farm-service/src/chemical/entities/chemical.entity.ts',
    'apps/farm-service/src/consumable/entities/consumable.entity.ts',
    'apps/farm-service/src/equipment/entities/equipment.entity.ts',
    'apps/farm-service/src/feed/entities/feed.entity.ts',
    'apps/farm-service/src/maintenance/entities/spare-part.entity.ts',
    'apps/farm-service/src/storage/entities/purchase-order.entity.ts',
    'apps/farm-service/src/worker/entities/worker.entity.ts',
    'apps/hr-service/src/hr/entities/employee.entity.ts',
  ].map((file) => ({
    file,
    finding: 'FARM-MEDIUM-327',
    reason: 'entity currency column still carries a literal DDL default',
  })),

  // FARM-MEDIUM-327, but the LIVE member of the set and the one this rule
  // found that a handler-only scan could not: `work_orders.currency` is
  // nullable with no default, while the derived `costSummary` jsonb requires a
  // non-null `currency`, so `updateCostSummary()` stamps TRY on every work
  // order created without one — whatever the tenant's currency is. An entity
  // method cannot reach FinanceSettingsService, so the fix is to derive the
  // cost summary in the handler that can, not to swap the literal.
  {
    file: 'apps/farm-service/src/maintenance/entities/work-order.entity.ts',
    finding: 'FARM-MEDIUM-327',
    reason: 'costSummary derives a non-null currency from a nullable column inside the entity',
  },
];

const EXEMPT_FILES = new Set(DECLARED_EXEMPTIONS.map((entry) => entry.file));

/** Every `*.handler.ts` and `*.entity.ts` under `apps/`, tests excluded. */
function listCurrencyWritingFiles(): string[] {
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
        continue;
      }
      if (entry.endsWith('.spec.ts')) continue;
      if (/\.(handler|entity)\.ts$/.test(entry)) out.push(full);
    }
  };
  walk(path.resolve(REPO_ROOT, 'apps'));
  return out;
}

function currencyLiteralsIn(file: string): string[] {
  const matches = readFileSync(file, 'utf8').match(CURRENCY_LITERAL);
  return matches ? [...new Set(matches)] : [];
}

function resolvedFindingIds(): Set<string> {
  const resolved = new Set<string>();
  for (const line of readFileSync(REGISTRY_PATH, 'utf8').trim().split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line) as { id?: unknown; state?: unknown };
    if (typeof entry.id === 'string' && entry.state === 'RESOLVED') resolved.add(entry.id);
  }
  return resolved;
}

describe('Finance currency SSoT invariant', () => {
  const files = listCurrencyWritingFiles();
  const offenders = new Map<string, string[]>();
  for (const file of files) {
    const literals = currencyLiteralsIn(file);
    if (literals.length > 0) offenders.set(path.relative(REPO_ROOT, file), literals);
  }

  it('scans every handler and entity under apps/ (extractor sanity)', () => {
    // A broken walker would report zero offenders and pass everything below.
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.endsWith('create-feeding-record.handler.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('payroll.entity.ts'))).toBe(true);
  });

  it('no handler or entity hardcodes a currency outside a declared exemption', () => {
    const undeclared = [...offenders]
      .filter(([file]) => !EXEMPT_FILES.has(file))
      .map(([file, literals]) => `${file} → ${literals.join(', ')}`);

    expect(undeclared).toEqual([]);
  });

  it('every declared exemption still carries a literal (the list only shrinks)', () => {
    const stale = DECLARED_EXEMPTIONS.filter((entry) => !offenders.has(entry.file)).map(
      (entry) => `${entry.file} (${entry.finding}) — no currency literal left; delete this entry`,
    );

    expect(stale).toEqual([]);
  });

  it('every exemption cites a finding the ledger still has open', () => {
    const resolved = resolvedFindingIds();
    const contradicted = DECLARED_EXEMPTIONS.filter((entry) => resolved.has(entry.finding)).map(
      (entry) => `${entry.file} cites ${entry.finding}, which is RESOLVED`,
    );

    expect(contradicted).toEqual([]);
  });
});
