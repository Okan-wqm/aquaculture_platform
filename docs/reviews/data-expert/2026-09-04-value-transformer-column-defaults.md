# TypeORM value transformers and column defaults — 2026-09-04

**Agent:** `data-expert` · **Mode:** CATCHER (read-only) · **Cycle:**
`2026-09-04-value-transformer-column-defaults`

**Scope:** every TypeORM `ValueTransformer` a column declaration in this
repository can install, and what each one answers for a value the caller never
provided.

**Why now:** wiring `farm-service:test:integration` into CI (INFRA-MEDIUM-142)
made `feeding-record-tenant-isolation.postgres.spec.ts` run for the first time.
It failed in its own fixture builder, against a column whose entity and
migration are both correct.

## Executive summary

TypeORM asks a column's transformer about **every** write, including columns the
caller never set — `ApplyValueTransformers.transformTo` runs unconditionally.
What comes back decides the SQL:

```js
// node_modules/typeorm/query-builder/InsertQueryBuilder.js
else if (value === undefined) { expression += "DEFAULT"; }
else                          { expression += this.createParameter(value); }
```

So a transformer that answers `null` for an unprovided value has not said
"nothing here" — it has said "write NULL". Two of the repository's seven
transformers said exactly that.

## Findings

### DATA-HIGH-013 — the decimal transformers collapse `undefined` into `null`

`libs/backend-common/src/database/decimal-transformer.ts` and
`libs/backend-common/src/monetary/decimal-column.decorator.ts` both opened with

```ts
if (value === null || value === undefined) {
  return null;
}
```

Every `NOT NULL DEFAULT` decimal column they guard was therefore unwritable
unless the caller named it explicitly:

```text
null value in column "used_capacity" of relation "storage_locations"
violates not-null constraint
```

— with the entity declaring `default: 0` and the Baseline declaring
`"used_capacity" numeric(15,2) NOT NULL DEFAULT '0'`. Both halves are correct,
which is what makes the failure read as an entity/migration mismatch and cost a
day of looking at the wrong two files.

**Blast radius:** 44 column declarations across 79 entity files pair
`DecimalTransformer` with a `default:`. On the money side,
`@MoneyColumn({ default: 0 })` guards `payments.refunded_amount`,
`invoices.amount_paid` and `subscription_module_items.discount_amount`, all
declared `numeric(19,4) NOT NULL DEFAULT '0'`.

**Not a behaviour change anywhere else.** For a `NOT NULL` column with no
DEFAULT the insert fails either way. For a nullable column with no DEFAULT,
`DEFAULT` _is_ NULL. And an explicit `null` still writes NULL, because clearing
a nullable column is a deliberate value rather than an omission — that
distinction is the whole fix.

**Fix:** both transformers return `undefined` for `undefined` and `null` for
`null`.

### The property, not the two files

Two of seven transformers had this defect and five did not:

| Transformer                                 | `to(undefined)` before |
| ------------------------------------------- | ---------------------- |
| `DecimalTransformer`                        | `null` — defect        |
| `DecimalValueTransformer` (`@MoneyColumn`)  | `null` — defect        |
| `BigIntTransformer`                         | `undefined`            |
| `BigIntStringTransformer`                   | `undefined`            |
| `createEncryptedColumnTransformer`          | `undefined`            |
| `EncryptedColumnTransformer` (sensor vault) | `undefined`            |
| `EncryptedProtocolConfigTransformer`        | `undefined`            |

That distribution is why fixing the two files is not the fix: the next
transformer is written by copying whichever neighbour the author opened first.
`tests/invariants/value-transformer-column-default.spec.ts` asserts the property
over every transformer instead.

Discovery there is **by use** rather than by a hand-kept list — a transformer
only affects a column by appearing as `transformer:` in that column's options,
so scanning `apps/`, `libs/` and `platform/` for that reference finds every
transformer that can do damage, including one added tomorrow. An identifier the
registry does not know fails the suite, so a new transformer is caught when it is
written rather than by the column that breaks months later.

## References

- Finding registry: `docs/reviews/_registry/findings.jsonl`
- Related: `INFRA-MEDIUM-142` (the lane that surfaced this), `DATA-CRITICAL-010`
- Rule SSoT: `CLAUDE.md`
