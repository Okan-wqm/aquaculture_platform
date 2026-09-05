/**
 * Platform-wide invariant — ADMIN-HIGH-004:
 *
 * `@platform/pagination-contracts` is the only place a paginated result is
 * DECLARED and the only place its page arithmetic is COMPUTED.
 *
 * # Why a ratchet and not a code review note
 *
 * The finding (docs/reviews/admin-expert/2026-08-16-pagination-result-authority.md)
 * counted a paginated result declared independently in four tiers, with field
 * sets that disagreed: `totalPages` was `0` for an empty page in some producers
 * and `1` in others, and `apps/admin-api-service/src/shared/response.interceptor.ts`
 * duck-typed the envelope so it recognised none of the real producers. A shared
 * TYPE alone would not have prevented that — every tier could still assemble the
 * object by hand, so the field sets could drift apart again the next time a
 * producer was written by copy-paste.
 *
 * This spec is therefore about DECLARATION and CONSTRUCTION, not naming:
 *
 *   (a) no production file under the consumer roots may declare its own
 *       paginated-result shape;
 *   (b) no production file may assemble a result object that computes
 *       `totalPages` inline;
 *   (c) no production file may derive a page count from a `total` with
 *       `Math.ceil` — `expectedTotalPages()` owns that one line.
 *   (d) no admin-api file may declare or return a bare `{ items, total }` —
 *       the shape rule (a) cannot see, because it carries neither `totalPages`
 *       nor `hasNextPage`.
 *
 * Source-only check; no DB, NATS or network dependency.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The lib that is allowed to declare and compute the page contract. */
const AUTHORITY_DIR = 'platform/libs/pagination-contracts/';

/**
 * The tiers the finding named, plus the two backend services that consume the
 * same helpers and the shared bridge that adapts the authority to NestJS. A new
 * root belongs here the moment it grows a list endpoint.
 */
const CONSUMER_ROOTS = [
  'apps/admin-api-service/src',
  'apps/farm-service/src',
  'apps/hr-service/src',
  'apps/sensor-service/src',
  'libs/backend-common/src',
  'platform/libs/cqrs/src',
  'web/modules/admin-panel/src',
  'web/modules/farm-module/src',
  'web/modules/hr-module/src',
] as const;

/**
 * The NestJS bridge re-declares the GraphQL ObjectType field-by-field because
 * `@Field()` decorators cannot be generated from a type alias. It is bound to
 * the authority by `implements IStandardPaginatedResult<T>`, which is exactly
 * the compile-time check this spec exists to approximate elsewhere.
 */
const DECLARATION_EXEMPT = ['libs/backend-common/src/pagination/pagination.dto.ts'];

function productionFiles(): string[] {
  const out = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', '--', ...CONSUMER_ROOTS.map((root) => `${root}/**`)],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
    .split('\n')
    .filter(Boolean)
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => !/\.spec\.tsx?$|\.test\.tsx?$/.test(file))
    .filter((file) => !file.includes('/__tests__/'))
    .filter((file) => !file.includes('/generated/'))
    .filter((file) => !file.startsWith(AUTHORITY_DIR));

  expect(out.length).toBeGreaterThan(500);
  return out;
}

/** A line the scanner already proved to exist; an out-of-range index is a scanner bug. */
function lineAt(lines: string[], index: number): string {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`admin-pagination-ssot: line index ${index} out of range (${lines.length})`);
  }
  return line;
}

/** `file:line` locations, so a failure names the exact place to fix. */
function locations(file: string, lines: string[], hits: number[]): string[] {
  return hits.map((index) => `${file}:${index + 1}  ${lineAt(lines, index).trim()}`);
}

const FIELD_LINE =
  /^\s*(?:readonly\s+)?(items|data|total|page|limit|totalPages|hasNextPage|hasPreviousPage)\??\s*:/;

/**
 * Walk every `{ … }` body that a declaration or an inline type literal opens,
 * and report the ones whose field set is the page contract restated.
 */
function localPageShapes(lines: string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lineAt(lines, i).trimEnd().endsWith('{')) continue;

    let depth = 0;
    const body: string[] = [];
    for (let j = i; j < lines.length; j += 1) {
      const line = lineAt(lines, j);
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
      if (j > i) body.push(line);
      if (depth === 0) break;
      // A body longer than a page contract is some other object.
      if (body.length > 12) break;
    }
    if (depth !== 0 || body.length > 12) continue;

    const fields = new Set<string>();
    for (const line of body) {
      const field = FIELD_LINE.exec(line)?.[1];
      if (field !== undefined) fields.add(field);
    }
    if (fields.has('totalPages') && (fields.has('items') || fields.has('hasNextPage'))) {
      hits.push(i);
    }
  }
  return hits;
}

/**
 * `totalPages:` as a key inside an object being BUILT — a type annotation
 * (`totalPages: number`) is a declaration and belongs to rule (a); anything
 * else on the right-hand side is a value someone computed here.
 */
const TOTAL_PAGES_ENTRY = /^\s*totalPages\s*\??\s*:\s*(.+?)\s*[,;]?\s*$/;
const TYPE_ANNOTATION = /^(?:number|Scalars\[)/;

function handBuiltTotalPages(line: string): boolean {
  const rhs = TOTAL_PAGES_ENTRY.exec(line)?.[1];
  return rhs !== undefined && !TYPE_ANNOTATION.test(rhs);
}

/** `Math.ceil(<something>total<something> / …)` — the duplicated derivation. */
const CEIL_OVER_TOTAL = /Math\.ceil\s*\(\s*[^)]*\btotal(?:Rows|Items|Count)?\b[^)]*\)/i;

describe('INVARIANT (ADMIN-HIGH-004): one pagination authority', () => {
  const files = productionFiles();
  const sources = new Map<string, string[]>(
    files.map((file) => [file, readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\n')]),
  );

  it('the authority exists and exports the constructor + guards the tiers rely on', () => {
    const index = readFileSync(resolve(REPO_ROOT, `${AUTHORITY_DIR}src/index.ts`), 'utf8');
    for (const name of [
      'createStandardPaginatedResult',
      'createPaginatedDataResultV1',
      'createCursorPaginationResultV1',
      'derivePaginationMetadataV1',
      'paginationMetadataV1',
      'expectedTotalPages',
      'isStandardPaginatedResult',
      'isCursorPaginationResultV1',
      'isPaginationMetadataV1',
      'hasUnissuedPaginationShapeV1',
    ]) {
      expect(index).toMatch(new RegExp(`export function ${name}\\b`));
    }
    expect(index).toMatch(/export interface PaginationResultV1<T>/);
  });

  it('(a) no consumer root declares its own paginated-result shape', () => {
    const offenders: string[] = [];
    for (const [file, lines] of sources) {
      if (DECLARATION_EXEMPT.includes(file)) continue;
      offenders.push(...locations(file, lines, localPageShapes(lines)));
    }
    expect(offenders).toEqual([]);
  });

  it('(b) no consumer root assembles a result object that sets totalPages', () => {
    const offenders: string[] = [];
    for (const [file, lines] of sources) {
      const hits = lines
        .map((line, index) => (handBuiltTotalPages(line) ? index : -1))
        .filter((index) => index >= 0);
      offenders.push(...locations(file, lines, hits));
    }
    expect(offenders).toEqual([]);
  });

  it('(c) no consumer root derives a page count from a total with Math.ceil', () => {
    const offenders: string[] = [];
    for (const [file, lines] of sources) {
      const hits = lines
        .map((line, index) => (CEIL_OVER_TOTAL.test(line) ? index : -1))
        .filter((index) => index >= 0);
      offenders.push(...locations(file, lines, hits));
    }
    expect(offenders).toEqual([]);
  });

  /**
   * (d) the completeness half rule (a) structurally cannot reach.
   *
   * Rule (a) recognises a re-declared page by `totalPages` paired with `items`
   * or `hasNextPage`. A bare `{ items, total }` has none of those, so it slips
   * through — and it is the variant that actually breaks the wire. It keys on
   * `items` exactly like the canonical envelope, so it reads as correct at
   * every callsite, but `isStandardPaginatedResult` requires all four numerics:
   * the interceptor does NOT recognise it, does NOT lift it, and the rows
   * arrive one level deeper than the consumer's `PaginatedResult<T>` says.
   *
   * Scoped to admin-api because that is where the transport boundary lives and
   * where the finding shipped. Deliberately NOT matched: the keyset/cursor
   * family (`items` + `totalCount` + `hasMore` + `cursor`), which is a
   * different pagination contract with its own authority and no `total` field.
   */
  it('(d) admin-api declares no bare { items, total } envelope', () => {
    const adminFiles = files.filter((file) => file.startsWith('apps/admin-api-service/src'));
    expect(adminFiles.length).toBeGreaterThan(100);

    const AD_HOC_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
      {
        name: 'ad-hoc envelope type (items: T[] … total: number)',
        re: /\bitems\s*:\s*[A-Za-z_][\w.<>[\] ]*\[\]\s*;[\s\S]{0,200}?\btotal\s*:\s*number/,
      },
      {
        name: 'ad-hoc envelope type (total: number … items: T[])',
        re: /\btotal\s*:\s*number\s*;[\s\S]{0,120}?\bitems\s*:\s*[A-Za-z_][\w.<>[\] ]*\[\]/,
      },
      {
        name: 'return-literal shorthand (return { items, total … })',
        re: /return\s*\{\s*items\s*[,:][\s\S]{0,200}?\btotal\s*[,:}]/,
      },
    ];

    const offenders: string[] = [];
    for (const file of adminFiles) {
      // Comments are stripped: an explanation of a removed shape necessarily
      // spells that shape out.
      const source = readFileSync(resolve(REPO_ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const { name, re } of AD_HOC_PATTERNS) {
        if (re.test(source)) offenders.push(`${file}  ->  ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the admin transport boundary fails closed on a page the authority did not mint', () => {
    const interceptor = readFileSync(
      resolve(REPO_ROOT, 'apps/admin-api-service/src/shared/response.interceptor.ts'),
      'utf8',
    );
    expect(interceptor).toMatch(/isStandardPaginatedResult\(/);
    expect(interceptor).toMatch(/paginationMetadataV1\(/);
    expect(interceptor).toMatch(/hasUnissuedPaginationShapeV1\(/);
    expect(interceptor).toMatch(/throw new UnissuedPaginationShapeError\(/);
    // The duck-typing this finding removed, and the casts that hid it.
    expect(interceptor).not.toMatch(/'data' in data/);
    expect(interceptor).not.toMatch(/\bas\s+(?:Record<|number\b|unknown\b|T\b)/);
  });

  it('the NestJS bridge delegates rather than re-deriving', () => {
    const bridge = readFileSync(
      resolve(REPO_ROOT, 'libs/backend-common/src/pagination/pagination.dto.ts'),
      'utf8',
    );
    expect(bridge).toMatch(/from '@platform\/pagination-contracts'/);
    expect(bridge).toMatch(/export type IStandardPaginatedResult<T> = PaginationResultV1<T>;/);
    expect(bridge).not.toMatch(/Math\.ceil/);
  });
});
