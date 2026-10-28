/**
 * REG-ID — the finding-id grammar has one owner: tools/gates/finding-id-grammar.ts.
 *
 * ## Why
 *
 * `finding-registry add` refused with "Finding ID space exhausted for domain
 * ARIA (maximum 999)": the sequence was three digits, and the three-digit
 * grammar was restated by hand at every site that read or wrote an id (the
 * allocator, the explicit-append check, the orphan heading, the trailer
 * grammar, the row schema, the Python readers). Widening the constant in one
 * of them would have left the others refusing the ids the first one issued.
 *
 * ## What this file pins
 *
 * The owner's whole surface, against ONE table
 * (tools/gates/fixtures/finding-id-grammar-table.json) that the Python owner
 * (aria-kernel/aria_kernel/finding_id_grammar.py) is held to by
 * aria-kernel/tests/test_finding_id_grammar.py: the two owners cannot import
 * each other, so the shared table is what makes them one grammar.
 *
 *   - the id regex: three digits (001..999) or four to a maximum of 9999 with
 *     no leading zero; an existing three-digit id stays valid;
 *   - `parseFindingId` / `formatFindingId` round-trip, zero-padding to at least
 *     three digits and refusing a sequence outside 1..9999;
 *   - `compareFindingIds` orders the sequence as a number (1000 after 999);
 *   - the allocator limit is 9999 and exhaustion is a NAMED error;
 *   - the registry row schema's id pattern accepts and refuses exactly what
 *     the owner does (a JSON file cannot import the owner, so the equivalence
 *     is pinned here instead), and the event schema takes its finding ids from
 *     that one pattern.
 *
 * This file pins NEW API the specification introduces (the module
 * `tools/gates/finding-id-grammar` does not exist at the branch base), so it is
 * red at the base by import — the only spec of REG-ID that is. It lives in
 * tests/invariants and not in tools/gates because the pre-commit hook runs every
 * tools/gates spec and a red one there cannot be committed.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  compareFindingIds,
  FINDING_ID_REGEX,
  FINDING_SEQUENCE_MAX,
  FindingIdSpaceExhaustedError,
  formatFindingId,
  parseFindingId,
} from '../../tools/gates/finding-id-grammar';

interface GrammarTable {
  readonly limit: number;
  readonly accept: ReadonlyArray<{
    readonly id: string;
    readonly domain: string;
    readonly classifier: string;
    readonly sequence: number;
  }>;
  readonly reject: readonly string[];
  readonly format: ReadonlyArray<{
    readonly domain: string;
    readonly classifier: string;
    readonly sequence: number;
    readonly id: string;
  }>;
  readonly formatRefused: readonly number[];
  readonly order: readonly string[];
}

const REPO_ROOT = resolve(__dirname, '..', '..');
const TABLE = JSON.parse(
  readFileSync(
    join(REPO_ROOT, 'tools', 'gates', 'fixtures', 'finding-id-grammar-table.json'),
    'utf8',
  ),
) as GrammarTable;
const REGISTRY_DIR = join(REPO_ROOT, 'docs', 'reviews', '_registry');

describe('REG-ID — the one table both grammar owners are held to', () => {
  it('holds the ids the specification names', () => {
    // The cases the package exists for; a table that lost one would pass a
    // grammar that lost it too.
    const accepted = TABLE.accept.map((entry) => entry.id);
    expect(accepted).toEqual(expect.arrayContaining(['ARIA-HIGH-999', 'ARIA-HIGH-1000']));
    expect(TABLE.reject).toEqual(
      expect.arrayContaining([
        'ARIA-HIGH-0999',
        'ARIA-HIGH-99',
        'aria-high-1000',
        'ARIA-HIGH-10000',
      ]),
    );
  });

  it('puts the allocator limit at 9999', () => {
    expect(FINDING_SEQUENCE_MAX).toBe(9999);
    expect(FINDING_SEQUENCE_MAX).toBe(TABLE.limit);
  });
});

describe('REG-ID — the TypeScript owner', () => {
  it('matches every tabled id and no refused one', () => {
    expect(FINDING_ID_REGEX.global).toBe(false);
    for (const entry of TABLE.accept) {
      expect({ id: entry.id, matches: FINDING_ID_REGEX.test(entry.id) }).toEqual({
        id: entry.id,
        matches: true,
      });
    }
    for (const id of TABLE.reject) {
      expect({ id, matches: FINDING_ID_REGEX.test(id) }).toEqual({ id, matches: false });
    }
  });

  it('parses a tabled id into its parts and refuses a refused one', () => {
    for (const entry of TABLE.accept) {
      expect(parseFindingId(entry.id)).toEqual({
        id: entry.id,
        domain: entry.domain,
        classifier: entry.classifier,
        sequence: entry.sequence,
      });
    }
    for (const id of TABLE.reject) {
      expect({ id, parsed: parseFindingId(id) }).toEqual({ id, parsed: null });
    }
  });

  it('formats with a zero pad to three digits and never truncates a longer sequence', () => {
    for (const entry of TABLE.format) {
      expect(formatFindingId(entry.domain, entry.classifier, entry.sequence)).toBe(entry.id);
    }
  });

  it('refuses to format a sequence the grammar cannot spell', () => {
    for (const sequence of TABLE.formatRefused) {
      expect(() => formatFindingId('ARIA', 'HIGH', sequence)).toThrow(RangeError);
    }
    expect(() => formatFindingId('ARIA', 'HIGH', Number.NaN)).toThrow(RangeError);
  });

  it('formats and parses as inverses over the whole sequence range', () => {
    for (const sequence of [1, 9, 10, 99, 100, 998, 999, 1000, 1001, 5000, 9998, 9999]) {
      const id = formatFindingId('ARIA', 'LOW', sequence);
      expect({ id, matches: FINDING_ID_REGEX.test(id) }).toEqual({ id, matches: true });
      expect(parseFindingId(id)?.sequence).toBe(sequence);
    }
  });

  it('orders the sequence as a number, never as text', () => {
    // The same domain and classifier, so the only thing that can order them is
    // the sequence. Text order puts 1000 and 1001 and 2000 before 999.
    const textOrder = [...TABLE.order].sort((left, right) => (left < right ? -1 : 1));
    expect(textOrder).not.toEqual([...TABLE.order]);
    expect([...TABLE.order].sort(compareFindingIds)).toEqual([...TABLE.order]);
    expect([...TABLE.order].reverse().sort(compareFindingIds)).toEqual([...TABLE.order]);
    expect(compareFindingIds('ARIA-LOW-999', 'ARIA-LOW-1000')).toBeLessThan(0);
    expect(compareFindingIds('ARIA-LOW-1000', 'ARIA-LOW-999')).toBeGreaterThan(0);
    expect(compareFindingIds('ARIA-LOW-1000', 'ARIA-LOW-1000')).toBe(0);
  });

  it('says what ran out when the space is exhausted', () => {
    const error = new FindingIdSpaceExhaustedError('ARIA');
    expect(error).toBeInstanceOf(RangeError);
    expect(error.name).toBe('FindingIdSpaceExhaustedError');
    expect(error.message).toMatch(/space exhausted/i);
    expect(error.message).toMatch(/ARIA/);
    expect(error.message).toMatch(/9999/);
  });
});

describe('REG-ID — the registry schemas', () => {
  const rowSchema = JSON.parse(
    readFileSync(join(REGISTRY_DIR, 'findings.jsonl.schema.json'), 'utf8'),
  ) as { properties: { id: { oneOf: ReadonlyArray<{ pattern?: string }> } } };
  const eventSchema = JSON.parse(
    readFileSync(join(REGISTRY_DIR, 'finding-event.schema.json'), 'utf8'),
  ) as { properties: { finding_id: { $ref?: string } } };

  it('admits exactly the ids the owner admits', () => {
    const pattern = rowSchema.properties.id.oneOf[0]?.pattern;
    expect(typeof pattern).toBe('string');
    const schemaPattern = new RegExp(pattern as string);
    const domains = /^\^\(([A-Z0-9|]+)\)-/.exec(pattern as string)?.[1]?.split('|') ?? [];
    // The schema keeps its closed domain alternation: a PR number cannot become a domain.
    expect(domains.length).toBeGreaterThan(10);
    for (const entry of TABLE.accept) {
      if (!domains.includes(entry.domain)) continue;
      expect({ id: entry.id, admitted: schemaPattern.test(entry.id) }).toEqual({
        id: entry.id,
        admitted: true,
      });
    }
    for (const id of TABLE.reject) {
      expect({ id, admitted: schemaPattern.test(id) }).toEqual({ id, admitted: false });
    }
  });

  it('takes the event schema’s finding ids from that one pattern', () => {
    expect(eventSchema.properties.finding_id.$ref).toMatch(
      /findings\.schema\.json#\/properties\/id$/,
    );
  });
});
