/**
 * snapshot-scrubber — PII redaction for SchemaSnapshot exports.
 * ============================================================================
 *
 * Plan v3 R14 (Phase 7 blocker). Schema-only snapshots leak PII via:
 *
 *   1. Column names — `national_id`, `bank_account_iban`, `ssn`,
 *      `passport_number`, etc. The NAMES themselves reveal
 *      processing purpose, which is KVKK-relevant.
 *   2. CHECK constraint literals — a CHECK that pins a column to a
 *      set of known tenant slugs leaks the full tenant list.
 *   3. columnDefault values — a default that encodes a known PII
 *      literal (rare but possible; defaults tend to be `NOW()` or
 *      'pending' but the shape allows anything).
 *
 * The scrubber produces a redacted copy of a SchemaSnapshot suitable
 * for upload to non-sovereign regions (compliance: EU → FRA1, TR →
 * Istanbul) OR for publication in public-facing channels (Slack,
 * email, dashboards).
 *
 * # What's kept
 *
 * - Table names (reveal module surface, already public per ADR-011).
 * - Column ordinal position + nullability + data_type (schema shape).
 * - Enum labels (reveal workflow states; operator-visible already).
 * - CHECK constraint definition's general structure (operator ?=
 *   columns + reserved-word predicates) with literals redacted.
 * - characterMaximumLength (an int, not PII).
 *
 * # What's redacted
 *
 * - Column names matching the PII deny-list → `<REDACTED_PII>` +
 *   a stable name hash so the shape remains diffable.
 * - CHECK constraint literals ('active' / 'tenant-abc-123') →
 *   `<REDACTED_LITERAL>`.
 * - columnDefault: values matching literal forms (strings, hex) are
 *   redacted; function calls (`NOW()`, `gen_random_uuid()`) are kept.
 */
import { createHash } from 'node:crypto';

import type {
  IntrospectedCheckConstraint,
  IntrospectedColumn,
  IntrospectedTable,
  SchemaSnapshot,
} from './pg-catalog-introspector';

/**
 * Column names that invariably carry PII — the scrubber redacts these
 * without further inspection. Operator-controlled allowlist is the
 * escape hatch for columns whose names collide with PII terms but
 * carry no actual PII (e.g. a numeric ID column named `identifier`).
 */
export const DEFAULT_PII_COLUMN_NAMES: ReadonlySet<string> = new Set([
  'national_id',
  'ssn',
  'social_security_number',
  'passport_number',
  'passport_no',
  'id_number',
  'tc_kimlik',
  'bank_account_iban',
  'iban',
  'bank_account_number',
  'credit_card_number',
  'credit_card',
  'cvv',
  'cc_number',
  'date_of_birth',
  'dob',
  'birth_date',
  'mother_name',
  'maiden_name',
  'phone_number',
  'mobile_number',
  'email',
  'email_address',
  'home_address',
  'address_line_1',
  'address_line_2',
  'full_name',
  'first_name',
  'last_name',
  'middle_name',
]);

export interface ScrubbedSnapshot extends SchemaSnapshot {
  /** Count of column names redacted — operator-visible marker. */
  readonly redactedColumnCount: number;
  /** Count of CHECK literals redacted. */
  readonly redactedCheckLiteralCount: number;
}

export interface ScrubOptions {
  /** Override or extend the default PII column deny-list. */
  readonly piiColumnNames?: ReadonlySet<string>;
  /**
   * Columns that MATCH the deny-list but are operator-declared safe
   * (e.g. numeric ID column happens to be named `id_number`). Scrubber
   * will NOT redact names in this set.
   */
  readonly allowlist?: ReadonlySet<string>;
}

/**
 * Produce a redacted copy of the snapshot. Pure function — does not
 * mutate the input. Deterministic: identical input + options produce
 * byte-identical output (important for diff + hash-chain usage).
 */
export function scrubSnapshot(
  snapshot: SchemaSnapshot,
  options: ScrubOptions = {},
): ScrubbedSnapshot {
  const piiSet = options.piiColumnNames ?? DEFAULT_PII_COLUMN_NAMES;
  const allowlist = options.allowlist ?? new Set<string>();
  let redactedColumnCount = 0;
  let redactedCheckLiteralCount = 0;

  const tables: IntrospectedTable[] = snapshot.tables.map((t) => ({
    ...t,
    columns: t.columns.map((c): IntrospectedColumn => {
      const nameLower = c.name.toLowerCase();
      if (piiSet.has(nameLower) && !allowlist.has(nameLower)) {
        redactedColumnCount++;
        return {
          ...c,
          name: redactedColumnPlaceholder(c.name),
          columnDefault: c.columnDefault !== null ? scrubDefault(c.columnDefault) : null,
        };
      }
      return {
        ...c,
        columnDefault: c.columnDefault !== null ? scrubDefault(c.columnDefault) : null,
      };
    }),
  }));

  const checkConstraints: IntrospectedCheckConstraint[] = snapshot.checkConstraints.map(
    (c) => {
      const scrubbed = scrubCheckDefinition(c.definition);
      if (scrubbed !== c.definition) redactedCheckLiteralCount++;
      return { ...c, definition: scrubbed };
    },
  );

  return {
    ...snapshot,
    tables,
    checkConstraints,
    redactedColumnCount,
    redactedCheckLiteralCount,
  };
}

/**
 * Stable placeholder — includes a short hash of the original name so
 * two scrubbed snapshots can be diffed for structure-only changes
 * without re-exposing the raw name.
 */
function redactedColumnPlaceholder(name: string): string {
  const h = createHash('sha256').update(name).digest('hex').slice(0, 10);
  return `<REDACTED_PII:${h}>`;
}

/**
 * Scrub a CHECK constraint definition. Replaces single-quoted literals
 * with `<REDACTED_LITERAL>`. Preserves the predicate structure +
 * column references + operators so operators can still read the
 * semantic intent.
 */
function scrubCheckDefinition(def: string): string {
  // Replace consecutive single-quoted literals: 'text with ''escaped''' → '<REDACTED>'.
  // Handle escaped quotes (doubled '') inside the literal.
  return def.replace(/'(?:[^']|'')*'/g, "'<REDACTED_LITERAL>'");
}

/**
 * Scrub a column default expression. Keeps function calls intact
 * (NOW(), gen_random_uuid(), CURRENT_TIMESTAMP) but redacts literal
 * strings + hex values that could encode PII defaults.
 */
function scrubDefault(def: string): string {
  // Function call → keep.
  if (/^[a-zA-Z_][a-zA-Z0-9_]*\s*\(/.test(def.trim())) return def;
  // Bare function keyword (CURRENT_TIMESTAMP, CURRENT_USER, etc).
  if (/^CURRENT_(TIMESTAMP|DATE|TIME|USER|ROLE|SCHEMA)$/i.test(def.trim())) return def;
  // Numeric literal → keep.
  if (/^-?\d+(\.\d+)?$/.test(def.trim())) return def;
  // Boolean → keep.
  if (/^(true|false|NULL)$/i.test(def.trim())) return def;
  // Anything else (string literal, byte string, cast-expression) →
  // redact while preserving an indicator that a default existed.
  return '<REDACTED_DEFAULT>';
}
