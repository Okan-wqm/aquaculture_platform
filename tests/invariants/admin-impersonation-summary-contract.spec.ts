/**
 * APA-297 — the impersonation aggregate has one owner, and its field names say
 * which period each number covers.
 *
 * # What was there
 *
 * Two endpoints computed overlapping aggregates over different periods.
 * `GET /impersonation/stats` was unparameterised and all-time; `GET
 * /impersonation/audit/summary` took a window, was richer, and had no consumer
 * at all. The page called the first and rendered it under a hardcoded "(30d)"
 * heading, so the most prominent number on a privileged-access audit surface
 * was wrong by however long the platform had been running.
 *
 * The windowed endpoint would not have saved it either: `totalSessions` there
 * counted `createdAt < end` and ignored `start`, so the one field a caller
 * would reach for was the one field the window did not reach.
 *
 * # The cure this gate pins
 *
 * One endpoint owns the aggregate, and the contract carries its own period:
 * `windowStart`/`windowEnd` come back with the numbers, and every field is
 * suffixed `InWindow` or `Now` so a windowed number cannot be read as a
 * point-in-time one (or labelled as one) by accident. The panel derives its
 * "(Nd)" heading from those bounds rather than writing a literal.
 *
 * The admin panel is a federated remote and cannot import a backend library —
 * its tsconfig resolves only `@/*` and `@aquaculture/shared-ui` — so the
 * contract is declared on both sides and pinned here, the same tier-3 pattern
 * as the analytics and report-definition parity gates.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/impersonation-debug.md#APA-297
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

const BACKEND_SERVICE = readFileSync(
  join(REPO_ROOT, 'apps/admin-api-service/src/impersonation/services/impersonation.service.ts'),
  'utf8',
);
const BACKEND_CONTROLLER = readFileSync(
  join(
    REPO_ROOT,
    'apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts',
  ),
  'utf8',
);
const FRONTEND_TYPES = readFileSync(
  join(REPO_ROOT, 'web/modules/admin-panel/src/services/types/impersonation.ts'),
  'utf8',
);
const FRONTEND_API = readFileSync(
  join(REPO_ROOT, 'web/modules/admin-panel/src/services/api/impersonation.ts'),
  'utf8',
);
const PAGE = readFileSync(
  join(REPO_ROOT, 'web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx'),
  'utf8',
);

/** Source with comments removed — a docblock naming a removed shape must not satisfy a rule about it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Top-level property names of an `interface X { … }` block.
 *
 * Brace depth is tracked so a field's own nested shape does not leak into its
 * parent's key set.
 */
function interfaceFields(source: string, name: string, where: string): string[] {
  const header = new RegExp(`export interface ${name}\\s*\\{`);
  const match = header.exec(source);
  if (!match) {
    throw new Error(`interface ${name} not found in ${where}`);
  }

  let depth = 0;
  let index = match.index + match[0].length - 1;
  const start = index;
  do {
    const char = source[index];
    if (char === '{') depth++;
    if (char === '}') depth--;
    index++;
  } while (depth > 0 && index < source.length);

  const body = source
    .slice(start + 1, index - 1)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const fields: string[] = [];
  let nesting = 0;
  for (const line of body.split('\n')) {
    if (nesting === 0) {
      const field = /^(\w+)\??\s*:/.exec(line.trim());
      if (field?.[1]) fields.push(field[1]);
    }
    nesting += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  return fields.sort();
}

describe('impersonation audit-summary contract (APA-297)', () => {
  it('the frontend mirror carries exactly the fields the backend sends', () => {
    const backend = interfaceFields(
      BACKEND_SERVICE,
      'ImpersonationAuditSummary',
      'admin-api-service',
    );
    const frontend = interfaceFields(
      FRONTEND_TYPES,
      'ImpersonationAuditSummary',
      'admin-panel',
    );

    expect(frontend).toEqual(backend);
  });

  it('every aggregate names the period it covers', () => {
    // The naming rule IS the fix. `totalSessions` sitting next to
    // `activeSessions` gave a renderer no way to tell a 30-day count from a
    // live one, and it guessed wrong.
    //
    // The rule is universal, not a list of known-risky prefixes: written as a
    // prefix match this check passed while `sessionsByReason`,
    // `topImpersonators`, `topTargetTenants` and `recentSessions` — every one of
    // them windowed — sat unqualified beside the fields it did cover. Only the
    // two window bounds are exempt, because they ARE the period.
    const fields = interfaceFields(
      BACKEND_SERVICE,
      'ImpersonationAuditSummary',
      'admin-api-service',
    );

    const unqualified = fields.filter(
      (field) =>
        !['windowStart', 'windowEnd'].includes(field) &&
        !field.endsWith('InWindow') &&
        !field.endsWith('Now'),
    );

    expect(unqualified).toEqual([]);
  });

  it('reports the window it used', () => {
    // Without these the panel has to assume a default that lives only inside
    // the service, which is how a "(30d)" label ended up over an all-time count.
    const code = withoutComments(BACKEND_SERVICE);
    expect(code).toMatch(/windowStart:\s*start\.toISOString\(\)/);
    expect(code).toMatch(/windowEnd:\s*end\.toISOString\(\)/);
  });

  it('windows the session total at both ends', () => {
    // The specific defect: `LessThan(end)` counted every session ever created
    // while every sibling aggregate honoured `start`.
    const summary = withoutComments(BACKEND_SERVICE).slice(
      withoutComments(BACKEND_SERVICE).indexOf('async getAuditSummary('),
    );

    expect(summary).toMatch(/createdAt:\s*Between\(start,\s*end\)/);
    expect(summary).not.toMatch(/createdAt:\s*LessThan\(end\)/);
  });

  it('keeps exactly one impersonation aggregate endpoint', () => {
    // GET /impersonation/stats was the all-time twin. Two endpoints computing
    // overlapping aggregates over different periods is what made the mislabel
    // possible in the first place.
    const controller = withoutComments(BACKEND_CONTROLLER);
    expect(controller).not.toMatch(/@Get\('stats'\)/);
    expect(withoutComments(BACKEND_SERVICE)).not.toMatch(/getImpersonationStats/);
    expect(withoutComments(FRONTEND_API)).not.toMatch(/getImpersonationStats/);
  });

  it('derives the period heading instead of writing it', () => {
    // A literal "(30d)" in the JSX cannot follow a change to the query.
    const page = withoutComments(PAGE);
    expect(page).not.toMatch(/\(30d\)/);
    expect(page).toMatch(/windowLabel/);
    expect(page).toMatch(/summary\.windowEnd/);
    expect(page).toMatch(/summary\.windowStart/);
  });

  it('sends the paginated session list its filters instead of filtering a page', () => {
    // The search box and status dropdown used to filter whatever rows were
    // already in the browser. Under a server-paginated table that answers
    // "no results" for a session sitting on page 2.
    const page = withoutComments(PAGE);
    expect(page).toMatch(/historyPagination\.page/);
    expect(page).toMatch(/search:\s*debouncedFilters\.search/);
    expect(withoutComments(BACKEND_CONTROLLER)).toMatch(/search\?:\s*string/);
    expect(withoutComments(BACKEND_SERVICE)).toMatch(/targetTenantName ILIKE :search/);
  });
});
