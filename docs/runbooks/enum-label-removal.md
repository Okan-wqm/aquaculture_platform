# Runbook: Enum Label Removal

**Referenced by**: `alignEnumLabels` primitive (Class F additive-only
contract).

**Purpose**: PostgreSQL has no `ALTER TYPE ... DROP VALUE`. Removing
an enum label safely requires a multi-step migration with application
cooperation. The `alignEnumLabels` primitive refuses the removal
direction; this runbook is the explicit operator path.

---

## When to invoke

- Drift validator reports Class F with `db-only: [...]` labels
  (DB enum carries values the entity no longer declares).
- Product decision removed an enum value (e.g. deprecated workflow
  state).
- A label was renamed and legacy rows must migrate to the new name.

## Canonical sequence

### Step 1 — Backfill rows using the value

Before dropping the label, every row that still references it must
switch to an approved value. Use `backfillColumn`:

```ts
await backfillColumn(qr, {
  schema: 'hr',
  table: 'leaves',
  updateExpr: sql.fragment`status = ${sql.value('archived')}`,
  filterExpr: sql.fragment`status = ${sql.value('deprecated')}`,
  chunkSize: 1000,
});
```

Verify zero rows remain at the removed label:

```sql
SELECT COUNT(*) FROM hr.leaves WHERE status = 'deprecated';
-- expect 0
```

### Step 2 — Create a new enum type WITHOUT the removed value

```sql
CREATE TYPE hr.leave_status_v2_enum AS ENUM (
  'pending', 'approved', 'rejected', 'archived'
);
```

Do NOT edit the original type — PG does not support removing a
value in-place.

### Step 3 — Migrate the column to the new type

```sql
ALTER TABLE hr.leaves
  ALTER COLUMN status TYPE hr.leave_status_v2_enum
    USING status::text::hr.leave_status_v2_enum;
```

This is a Class H operation (data re-encode). If any row still
holds `'deprecated'` the cast fails — Step 1's verification MUST
be green before Step 3.

### Step 4 — Drop the legacy type

```sql
DROP TYPE hr.leave_status_enum;
```

### Step 5 — Rename the new type to the canonical name

```sql
ALTER TYPE hr.leave_status_v2_enum RENAME TO leave_status_enum;
```

The entity declaration stays `@Column({enum: LeaveStatus,
enumName: 'leave_status_enum'})` throughout — only the underlying
PG type churns.

## Why this is NOT a primitive

`alignEnumLabels` is additive-only by design. Packaging Steps 1–5
into a single "remove enum label" primitive would bundle an UPDATE
(data migration) with a multi-step type swap (schema migration)
across a boundary operators must consent to per-rollout. The
refusal is the control.

## Post-removal validation

- Drift validator reports no Class F violations for the entity.
- Drift-class-parity invariant green.
- Sampling confirms no row references the removed value.

## References

- ADR-011 Schema Ownership
- drift-classes.ts Class F
- `alignEnumLabels` primitive docblock
