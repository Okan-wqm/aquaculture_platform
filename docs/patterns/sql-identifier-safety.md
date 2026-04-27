# SQL Identifier Safety — set_config for search_path, SqlFragment for Everything Else

**Status**: Canonical pattern (Plan v3 R1 + R2)
**Related**: `libs/backend-common/src/database/sql-fragments.ts`, ADR-022, ADR-023
**Applies to**: every file under `apps/**/src/database/migrations/`, `apps/db-migrate/src/`, `libs/backend-common/src/database/`

## TL;DR

- **Never** interpolate a PostgreSQL identifier into a raw SQL string. Even if the identifier passed `SAFE_IDENT_RE` once upstream.
- For `search_path`, use `set_config('search_path', $1, true)` parameterised — NOT `SET LOCAL search_path "<...>"`.
- For identifiers in DDL/DML, use `sql.ident('name')` (branded `SqlIdent`). Raw string in a `SqlFragment` interpolation slot is a TypeScript compile error.
- For values, use `sql.value(v)` (branded `SqlValue`) — rendered as `$N` placeholder.

## The Problem

### Why identifier interpolation is an injection class even with SAFE_IDENT_RE

```ts
// BAD — common pattern in migrations before plan v3
const tenantSchema = (await getTenantSchemas())[0];
await qr.query(`SET LOCAL search_path "${tenantSchema}", public`);
```

This is safe ONLY if:
1. `tenantSchema` was validated against `SAFE_IDENT_RE` at EVERY upstream layer
2. The validation was done CORRECTLY (regex anchored with `^...$`, not `^...`)
3. No middleware / ORM call rewrites the value between validation and use
4. The value came from a trusted source to begin with

In practice the third and fourth conditions are subtle. For `tenantSchema` specifically, the value comes from `information_schema.schemata` which is populated by `TenantSchemaSyncService` (`libs/backend-common/src/database/tenant-schema-sync.service.ts`). Any path through `auth-service` tenant-provisioning that accepts user input (tenant slug, company name) into schema name construction can produce a malicious schema that bypasses construction-time validation but survives to orchestrator read-time.

The conservative position: **identifiers at cross-trust-boundary paths must be re-validated at read-time AND emitted via parameterized path or branded-type path**. Never trust the upstream.

### Why `SET LOCAL <identifier>` is a parameterization footgun

PostgreSQL's `SET` / `SET LOCAL` statement does NOT accept bind parameters for the setting name OR value. You cannot write `SET LOCAL search_path $1`. Authors reach for string interpolation because that's the only way to fit the value in.

`set_config(name, value, is_local)` IS a regular function call that accepts bind parameters:

```sql
SELECT set_config('search_path', $1, true)
```

The boolean `is_local=true` makes it equivalent to `SET LOCAL` semantics (reset at transaction end).

## The Pattern

### 1. search_path — parameterised set_config

```ts
// GOOD — parameterised, identifier-safe
await qr.query('SELECT set_config($1, $2, true)', ['search_path', tenantSchema]);

// BAD — identifier interpolation
await qr.query(`SET LOCAL search_path "${tenantSchema}", public`);
```

Notes:
- The `true` boolean is `is_local`; use `false` only when you genuinely want the setting to survive the transaction (rare).
- If you need `<tenant>, public` multi-entry search_path, PG accepts comma-separated in the value: `set_config('search_path', `${tenantSchema},public`, true)` — but the tenantSchema part must STILL be re-validated via `SAFE_IDENT_RE` at the boundary because the value contains the identifier text, even though it's parameterised. `set_config` doesn't quote the value — it's interpreted by the PG setting-parser.
- For absolute safety on multi-entry search_path, pre-validate `tenantSchema` via `sql.ident()` (throws on invalid) and then compose: `set_config('search_path', sql.ident(tenantSchema).raw + ',public', true)`. The `.raw` access is the opt-out that forces the author to confront the un-quoted nature of the output.

### 2. DDL identifiers — sql.ident + sql.fragment

```ts
import { sql, executeSqlFragment } from '@aquaculture/backend-common';

const schema = sql.ident('hr');
const table = sql.ident('employee_certifications');
const column = sql.ident('status');
const newEnum = sql.ident('employee_certifications_status_enum');

// Fragment: placeholders auto-numbered, identifiers auto-quoted.
const fragment = sql.fragment`
  ALTER TABLE ${schema}.${table}
  ALTER COLUMN ${column}
  TYPE ${newEnum}
  USING ${column}::text::${newEnum}
`;
await executeSqlFragment(qr, fragment);

// Under the hood fragment.sql is:
//   ALTER TABLE "hr"."employee_certifications"
//   ALTER COLUMN "status"
//   TYPE "employee_certifications_status_enum"
//   USING "status"::text::"employee_certifications_status_enum"
// fragment.params is [] (no user values).
```

A raw string in the interpolation slot is a TypeScript compile error:

```ts
// TS ERROR: string literal not assignable to SqlIdent | SqlValue | SqlFragment
sql.fragment`ALTER TABLE ${'hr'}.${'payrolls'} ...`;
```

### 3. Values — sql.value parameterization

```ts
const id = sql.value(tenantId);           // arbitrary value, will be $N
const threshold = sql.value(100);
const fragment = sql.fragment`
  UPDATE ${schema}.${table}
  SET status = ${sql.value('archived')}
  WHERE tenant_id = ${id} AND row_count > ${threshold}
`;
// fragment.sql: UPDATE "hr"."t" SET status = $1 WHERE tenant_id = $2 AND row_count > $3
// fragment.params: ['archived', <tenantId>, 100]
```

### 4. Composition — nested fragments

Fragments compose; placeholder indices are rewritten so the final `$N` sequence is contiguous.

```ts
const subqueryFragment = sql.fragment`SELECT id FROM ${schema}.audit WHERE event = ${sql.value('created')}`;
const mainFragment = sql.fragment`UPDATE ${schema}.${table} SET processed = true WHERE id IN (${subqueryFragment})`;
// mainFragment.params is ['created'] — the subquery's params merged into parent.
```

## Migration Path for Existing Code

Not a big-bang — `base-migration.ts` primitives continue to work with raw strings until Phase 3 migrates them. Incremental rollout:

1. **New migration code** (any file you touch after 2026-04-21) MUST use `sql.ident` / `sql.fragment`.
2. **Existing migration code** (`base-migration.ts` helpers + previously-shipped migrations) stays as-is until Phase 3 primitives rewrite.
3. **Cross-boundary paths** — anywhere tenantSchema enters a `SET`-like statement — MUST migrate immediately (SEC-CRITICAL-06 from plan v3 R1). Orchestrator `search_path` pin is the canonical first mover.

## Gotchas

### set_config vs SET LOCAL semantic equivalence

They are NOT 100% equivalent. `set_config(..., true)` attaches to the NEAREST transaction. If you're not in a transaction, it's a no-op (returns the current value, does nothing else). `SET LOCAL` issues a warning + no-op if no transaction.

If you want a session-level change (no transaction required), use `set_config(..., false)` — equivalent to plain `SET` (not SET LOCAL). Usually you don't want this at migration time.

### `sql.ident` identifier length limit

PostgreSQL's identifier limit is 63 characters. `sql.ident` throws on longer input. Most real names fit; but auto-generated constraint names can approach the limit. If you're generating constraint names programmatically, measure + truncate before calling `sql.ident`.

### `sql.ident` reserved word blocklist

`sql.ident` rejects common SQL keywords (`select`, `drop`, `table`, `from`, `where`, ...). Even quoted these are legal PostgreSQL but invite confusion. Rename the object.

If you MUST use a reserved word (legacy), edit `libs/backend-common/src/database/sql-fragments.ts` `RESERVED_IDENTS` set with a justification comment. Do not use a different helper to bypass.

### `sql.fragment` runtime guard

The branded types make raw-string interpolation a TypeScript compile error. BUT if someone `@ts-ignore`s around it or uses `as SqlIdent` casts, a belt-and-braces runtime guard in `sql.fragment` throws. The runtime guard is the last line of defense; rely on it only for incident-time.

## Verification

- `libs/backend-common/src/database/__tests__/sql-fragments.spec.ts` — 24 behavioral tests
- Every migration touched by Phase 3 onwards MUST add a `.migration.spec.ts` that exercises the branded-type path

## References

- `libs/backend-common/src/database/sql-fragments.ts` — source + JSDoc
- PostgreSQL `set_config` docs: https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET
- PostgreSQL `SET` docs: https://www.postgresql.org/docs/current/sql-set.html
- Plan v3 §v3 Revisions table — R1, R2 CRITICAL rows
- CLAUDE.md Architectural Approach — Tier-1 make-impossible
