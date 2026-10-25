/**
 * The ONE owner of the registry finding-id grammar, TypeScript side (REG-ID).
 *
 * An id is `DOMAIN-CLASSIFIER-SEQUENCE`: an upper-case alphanumeric domain that
 * starts with a letter, a classifier (a severity for every id the registry
 * stores; `CVE`, `DATAMIG` and the allocator's synthetic `RESERVED` are the
 * classifiers a reader may meet besides), and a sequence of three digits
 * (001..999) or four with no leading zero (1000..9999). An existing three-digit
 * id stays valid and is never rewritten.
 *
 * ## Why one module
 *
 * `finding-registry add` refused with "Finding ID space exhausted for domain
 * ARIA (maximum 999)". The sequence was not one constant: every site that read,
 * wrote, sorted or matched an id spelled the three digits itself (`\d{3}`,
 * `[0-9]{3}`, `padStart(3`, `slice(-3)`, `> 999`), so widening one left the
 * others refusing what the first issued. Every site now calls this module;
 * tests/invariants/finding-id-grammar.spec.ts fails a file under tools/, tests/
 * or aria-kernel/ that spells the grammar again.
 *
 * ## The other owners
 *
 * Python cannot import this file: aria-kernel/aria_kernel/finding_id_grammar.py
 * is the Python owner. They are one GRAMMAR because both are held to one table,
 * tools/gates/fixtures/finding-id-grammar-table.json (tests/invariants/
 * finding-id-grammar-table.spec.ts, aria-kernel/tests/test_finding_id_grammar.py).
 * The registry row schema (docs/reviews/_registry/findings.jsonl.schema.json) and
 * scripts/ci/lib/reviewed-exception.mjs are data and plain ESM that cannot call
 * a function; the same table pins what each of them admits.
 *
 * Widening the space again is one constant, FINDING_SEQUENCE_DIGITS, and the
 * table.
 */

/** The severities a registry row carries; the classifier of every stored id. */
export const FINDING_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

/** Digits an id spells at least (`001`) and at most (`9999`). */
const FINDING_SEQUENCE_MIN_DIGITS = 3;
const FINDING_SEQUENCE_DIGITS = 4;

/** The last sequence an id can carry, and so the allocator's limit. */
export const FINDING_SEQUENCE_MAX = 10 ** FINDING_SEQUENCE_DIGITS - 1;

/**
 * The grammar as regex source, for a reader that embeds an id in a larger
 * pattern (a trailer, a heading, a scan of prose). No anchors, no capture
 * groups: the embedding pattern keeps its own group numbering.
 */
export const FINDING_DOMAIN_SOURCE = '[A-Z][A-Z0-9]*';
/**
 * The longer spelling first and a closing look-ahead, so the sequence is read
 * whole wherever it is embedded: `1000` is not `100` followed by a stray `0`,
 * and `0999` and a fifth digit are no sequence at all, anchored or not.
 */
export const FINDING_SEQUENCE_SOURCE =
  `(?:[1-9][0-9]{${FINDING_SEQUENCE_MIN_DIGITS},${FINDING_SEQUENCE_DIGITS - 1}}` +
  `|[0-9]{${FINDING_SEQUENCE_MIN_DIGITS}})(?![0-9])`;
export const FINDING_SEVERITY_SOURCE = `(?:${FINDING_SEVERITIES.join('|')})`;
export const FINDING_ID_SOURCE = `${FINDING_DOMAIN_SOURCE}-${FINDING_SEVERITY_SOURCE}-${FINDING_SEQUENCE_SOURCE}`;

/** A domain on its own. */
export const FINDING_DOMAIN_REGEX = new RegExp(`^${FINDING_DOMAIN_SOURCE}$`);

/** A severity-qualified id; groups: domain, classifier, sequence. Never global. */
export const FINDING_ID_REGEX = new RegExp(
  `^(${FINDING_DOMAIN_SOURCE})-(${FINDING_SEVERITIES.join('|')})-(${FINDING_SEQUENCE_SOURCE})$`,
);

/** The shape of an id whatever its classifier says; groups as FINDING_ID_REGEX. */
const FINDING_ID_SHAPE_REGEX = new RegExp(
  `^(${FINDING_DOMAIN_SOURCE})-([A-Z0-9]+)-(${FINDING_SEQUENCE_SOURCE})$`,
);

export interface ParsedFindingId {
  readonly id: string;
  readonly domain: string;
  readonly classifier: string;
  readonly sequence: number;
}

function parsedFrom(id: string, match: RegExpExecArray | null): ParsedFindingId | null {
  const [, domain, classifier, sequence] = match ?? [];
  if (domain === undefined || classifier === undefined || sequence === undefined) return null;
  return { id, domain, classifier, sequence: Number.parseInt(sequence, 10) };
}

/** The parts of a severity-qualified id, or null when it is not one. */
export function parseFindingId(id: string): ParsedFindingId | null {
  return parsedFrom(id, FINDING_ID_REGEX.exec(id));
}

/**
 * The parts of an id of any classifier (`ARIA-HIGH-001`, `RUST-CVE-004`, the
 * allocator's `ORPHAN-RESERVED-031`), or null. For a reader that claims the
 * sequence an id holds and does not care what it is called.
 */
export function parseFindingIdShape(id: string): ParsedFindingId | null {
  return parsedFrom(id, FINDING_ID_SHAPE_REGEX.exec(id));
}

/** Whether `sequence` is one an id can be allocated, or reserved, with. */
export function isAllocatableSequence(sequence: number): boolean {
  return Number.isInteger(sequence) && sequence >= 1 && sequence <= FINDING_SEQUENCE_MAX;
}

/** A sequence as an id spells it: zero-padded to three digits, never truncated. */
export function formatFindingSequence(sequence: number): string {
  return String(sequence).padStart(FINDING_SEQUENCE_MIN_DIGITS, '0');
}

/** The id of `sequence` in `domain` under `classifier`. */
export function formatFindingId(domain: string, classifier: string, sequence: number): string {
  if (!isAllocatableSequence(sequence)) {
    throw new RangeError(
      `Finding sequence must be an integer between ${formatFindingSequence(1)} and ${FINDING_SEQUENCE_MAX}: ${sequence}`,
    );
  }
  const id = `${domain}-${classifier}-${formatFindingSequence(sequence)}`;
  if (parseFindingIdShape(id) === null) {
    throw new TypeError(`Not a finding id: ${id}`);
  }
  return id;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function shapeOf(id: string): ParsedFindingId {
  const parsed = parseFindingIdShape(id);
  if (parsed === null) throw new TypeError(`Not a finding id: ${id}`);
  return parsed;
}

/**
 * The registry's order of ids: domain, classifier, then the SEQUENCE AS A
 * NUMBER. A text order puts 1000 between 100 and 999.
 */
export function compareFindingIds(left: string, right: string): number {
  const a = shapeOf(left);
  const b = shapeOf(right);
  return (
    compareText(a.domain, b.domain) ||
    compareText(a.classifier, b.classifier) ||
    a.sequence - b.sequence
  );
}

/** The sequences of `domain` ran out: the allocator cannot name a next id. */
export class FindingIdSpaceExhaustedError extends RangeError {
  public constructor(public readonly domain: string) {
    super(`Finding ID space exhausted for domain ${domain} (maximum ${FINDING_SEQUENCE_MAX}).`);
    this.name = 'FindingIdSpaceExhaustedError';
  }
}
