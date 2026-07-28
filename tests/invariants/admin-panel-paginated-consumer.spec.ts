/**
 * APA-106 — a paginated response must not be tested with `Array.isArray` and
 * silently replaced with `[]`.
 *
 * RC-1's backend half is done: every admin-api list producer returns
 * `createStandardPaginatedResult`, the `ResponseInterceptor` lifts `items` into
 * the envelope's `data` slot with the numerics in `meta`, and the http-client
 * flattens that into `PaginatedResult<T>` = `{ data, total, page, limit,
 * totalPages }`. The consumer half was never finished.
 *
 * Two pages still received that object and asked `Array.isArray(response)`.
 * It is not an array, so both took the `: []` branch on EVERY load. The
 * discount-code table could therefore never list a code — every code persisted
 * and none was ever visible, deactivatable or inspectable — and the maintenance
 * window list was permanently empty.
 *
 * What makes this class dangerous is that the guard was written to be SAFE. It
 * cannot throw, so there is no stack trace, no error toast and no failed
 * request in the network tab: the page renders a clean, confident "no rows".
 * A crash would have been reported on day one. This is strictly worse.
 *
 * The rule: if an api function is declared `PaginatedResult<…>`, its consumers
 * read `.data`. Testing the envelope itself for array-ness is always wrong —
 * it is never an array, so the guard has exactly one possible outcome.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/billing-plans.md#APA-106
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PANEL = join(__dirname, '..', '..', 'web/modules/admin-panel/src');
const API_DIR = join(PANEL, 'services/api');
const PAGES_DIR = join(PANEL, 'pages');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      found.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.spec\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every api function declared to return a paginated envelope. */
function paginatedApiFunctions(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(API_DIR)) {
    const source = withoutComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(
      /(\w+):\s*(?:async\s*)?\([^)]*\)\s*=>[\s\S]{0,200}?apiFetch<\s*PaginatedResult</g,
    )) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names].sort();
}

describe('admin-panel paginated consumers (APA-106)', () => {
  const paginated = paginatedApiFunctions();
  const pages = sourceFiles(PAGES_DIR);

  it('finds the paginated api surface to protect', () => {
    // Guards the gate: a parser that matches nothing would pass forever.
    expect(paginated.length).toBeGreaterThan(3);
  });

  it.each(pages.map((file) => [file.slice(PANEL.length + 1), file]))(
    '%s never array-tests a paginated envelope',
    (_name, file) => {
      const source = withoutComments(readFileSync(file, 'utf8'));

      // Bind each `const X = await <api>.<paginatedFn>(...)` to its variable,
      // then look for `Array.isArray(X)` on the envelope itself. Reading
      // `Array.isArray(X.data)` is correct and deliberately not matched.
      //
      // The search is bounded to the text between this binding and the NEXT
      // binding of the same name: a short name like `result` is routinely
      // re-bound in a sibling function, and an unbounded scan would blame this
      // call for that one's guard.
      const bindings = [
        ...source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+[\w.]*\.(\w+)\s*\(/g),
      ];
      const offending: string[] = [];
      for (const [index, call] of bindings.entries()) {
        const [, variable, fn] = call;
        if (!variable || !fn || !paginated.includes(fn)) continue;

        const next = bindings
          .slice(index + 1)
          .find((later) => later[1] === variable);
        const region = source.slice(call.index ?? 0, next?.index ?? source.length);

        if (new RegExp(`Array\\.isArray\\(\\s*${variable}\\s*\\)`).test(region)) {
          offending.push(`${variable} = ${fn}(...)`);
        }
      }

      expect(offending).toEqual([]);
    },
  );

  it('declares the discount-code list as the paginated response it is', () => {
    // The specific CRITICAL: typed `DiscountCode[]` against a producer that
    // returns `createStandardPaginatedResult`, which is what made the page's
    // "safe" guard select `[]` on every load.
    const billing = readFileSync(join(API_DIR, 'billing.ts'), 'utf8');

    expect(billing).toMatch(/getDiscountCodes[\s\S]{0,200}?PaginatedResult<DiscountCode>/);
    expect(billing).not.toMatch(/getDiscountCodes[\s\S]{0,120}?apiFetch<DiscountCode\[\]>/);
  });
});
