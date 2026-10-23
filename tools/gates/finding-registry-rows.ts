/**
 * finding-registry-rows — the registry's row contract, applied by every writer.
 *
 * WHAT A ROW MUST BE. `docs/reviews/_registry/findings.jsonl.schema.json` is the
 * row contract; `finding-evidence-shape.ts` adds the evidence-shape rule for
 * rows created after its cutover. `rowContractViolations` is the one reader of
 * both, so the append path, the rechain path and the write sink cannot
 * disagree about what a valid row is.
 *
 * WHY A WRITE SINK (ARIA-HIGH-044). The append path validated the row it
 * added, and nothing else validated anything: `close`, `reopen`, `sweep`,
 * `reconcile` and `dedupe` rewrite rows in place and wrote whatever they
 * produced. A rule placed in the schema therefore bound `add` and no other
 * mutator — a `reopen` of an ownerless RESOLVED CRITICAL, or a sweep of an
 * ownerless one to BLOCKED, wrote exactly the row the schema forbids.
 * `refuseInvalidChangedRows` runs inside the registry's only write function
 * (`writeRegistry` in finding-registry.ts), so every mutator, including one
 * written later, inherits the contract without remembering to ask for it.
 *
 * WHY ONLY CHANGED ROWS. The integrity invariant
 * (tests/invariants/finding-registry-integrity.spec.ts) already judges the
 * whole ledger on every PR. A writer that refused because of a row it did not
 * touch would let one bad merged row halt every unrelated close and the
 * reconcile lane; checking what this write changes keeps the refusal on the
 * write that caused it.
 */

import { readFileSync } from 'node:fs';

// The .js extension on the ajv specifier is a real file in node_modules, so
// both ts-node (CommonJS) and ts-jest resolve it. ajv's CommonJS entry sets
// `__esModule` and `exports.default`, so the esModuleInterop default import is
// the class itself, exactly as for `ajv-formats` below.
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  findNonCanonicalFindingEvidence,
  type NonCanonicalFindingEvidence,
  requiresCanonicalFindingEvidence,
} from './finding-evidence-shape';
import { canonicalJson, type Finding } from './finding-registry-chain';
import { ownerViolations } from './finding-registry-owners';

/**
 * Ajv-compiled validator for the finding schema, compiled once per schema
 * path. Before the append path used it, historical seed scripts wrote entries
 * with free-text evidence and over-long titles that violated the schema; those
 * entries survived until the invariant ran post-hoc.
 */
const cachedValidators = new Map<string, ValidateFunction>();
function loadRowValidator(schemaPath: string): ValidateFunction {
  const cached = cachedValidators.get(schemaPath);
  if (cached) return cached;
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator = ajv.compile(schema);
  cachedValidators.set(schemaPath, validator);
  return validator;
}

export interface RowContractViolations {
  /**
   * `<instancePath>: <message> (<keyword>)`, one per schema error; on a schema-valid row, the
   * created_at time rule (`createdAtViolation`).
   */
  readonly schema: readonly string[];
  /** Non-canonical evidence items; checked only on a schema-valid row. */
  readonly evidence: readonly NonCanonicalFindingEvidence[];
}

/**
 * A row cannot be created after the write that records it. `created_at` is the ledger's time: the
 * staleness sweep and dedup's winner read it, and the hash chain seals it once merged. Four rows
 * were once appended stamped about 9 h after the commit that added them (SE-3-R2 corrective R5);
 * every writer passes through this contract, so such a row is refused at the write. Rows already
 * in the ledger are not re-judged: only the rows a write changes reach this rule.
 */
function createdAtViolation(createdAt: unknown, now: Date): string | null {
  if (typeof createdAt !== 'string') return null; // the schema requires and types it
  const created = Date.parse(createdAt);
  if (Number.isNaN(created) || created <= now.getTime()) return null;
  return `/created_at ${createdAt} is after the write time ${now.toISOString()} (created_at)`;
}

/**
 * The row contract for one row. `evidence: 'always'` is the append path's
 * rule (a row written now is held to today's evidence shape whatever its
 * `created_at` says); `'post-cutover'` keeps the relaxed contract historical
 * rows were written under. `now` is the time of the write being judged.
 */
export function rowContractViolations(
  row: unknown,
  schemaPath: string,
  evidence: 'always' | 'post-cutover',
  now: Date = new Date(),
): RowContractViolations {
  const validate = loadRowValidator(schemaPath);
  if (!validate(row)) {
    return {
      schema: (validate.errors ?? []).map(
        (error) => `${error.instancePath || '<root>'}: ${error.message} (${error.keyword})`,
      ),
      evidence: [],
    };
  }
  const finding = row as { created_at?: unknown; evidence?: unknown[] };
  const future = createdAtViolation(finding.created_at, now);
  const schema = future === null ? [] : [future];
  if (evidence === 'post-cutover' && !requiresCanonicalFindingEvidence(finding.created_at)) {
    return { schema, evidence: [] };
  }
  return { schema, evidence: findNonCanonicalFindingEvidence(finding.evidence) };
}

function rowBody(entry: Finding): string {
  const { prev_hash: _prev, content_hash: _content, ...body } = entry;
  return canonicalJson(body);
}

/**
 * The rows of `next` that are new or differ from the row with the same id in
 * `previous`. Chain hashes are excluded: a rechain moves every later hash and
 * changes no row.
 */
export function changedRows(previous: readonly Finding[], next: readonly Finding[]): Finding[] {
  const before = new Map(previous.map((entry) => [entry.id, rowBody(entry)]));
  return next.filter((entry) => before.get(entry.id) !== rowBody(entry));
}

const ACCOUNTABILITY_HINT =
  'An unresolved CRITICAL needs a non-blank owner_user and a deadline ($defs/accountable); ' +
  'give a row registered before that rule its fields with: finding-registry assign <id> ' +
  '--owner-user=<handle> --deadline=<YYYY-MM-DD> --reason=<why>.';

export class RegistryWriteRefused extends Error {
  public constructor(public readonly violations: readonly string[]) {
    const accountability = violations.some((line) => /owner_user|deadline/.test(line));
    super(
      `registry write refused: ${violations.length} violation(s) in the rows this write changes ` +
        `(findings.jsonl.schema.json); nothing was written.\n  ${violations.join('\n  ')}` +
        (accountability ? `\n${ACCOUNTABILITY_HINT}` : ''),
    );
    this.name = 'RegistryWriteRefused';
  }
}

/**
 * Throws `RegistryWriteRefused` when a row this write changes breaks the row
 * contract, or when the write sets an owner_user that is not a CODEOWNERS
 * handle (ARIA-MEDIUM-535, finding-registry-owners.ts).
 */
export function refuseInvalidChangedRows(
  previous: readonly Finding[],
  next: readonly Finding[],
  schemaPath: string,
): void {
  const changed = changedRows(previous, next);
  const violations: string[] = [...ownerViolations(previous, changed)];
  for (const row of changed) {
    const found = rowContractViolations(row, schemaPath, 'post-cutover');
    for (const message of found.schema) violations.push(`${row.id} ${message}`);
    for (const item of found.evidence) {
      violations.push(`${row.id} evidence[${item.index}]: ${JSON.stringify(item.evidence)}`);
    }
  }
  if (violations.length > 0) throw new RegistryWriteRefused(violations);
}
