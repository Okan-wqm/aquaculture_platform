# Research: PostgreSQL Constraint Completeness — NOT NULL, CHECK, Foreign Key ON DELETE / ON UPDATE, Defaults

**Topic:** Enterprise constraint hygiene for multi-tenant PostgreSQL schemas — NOT NULL discipline, CHECK constraints for enumerated values, foreign-key referential actions, and the "DB default vs app default" decision.
**Date:** 2026-04-08
**Agent:** database-reviewer

## Sources
- [PostgreSQL: Documentation 15 — Constraints](https://www.postgresql.org/docs/15/ddl-constraints.html)
- [PostgreSQL: Documentation 15 — Data Definition (Defaults)](https://www.postgresql.org/docs/15/ddl-default.html)
- [PostgreSQL: Documentation 15 — Enumerated Types](https://www.postgresql.org/docs/15/datatype-enum.html)
- [PostgreSQL: Documentation 15 — CREATE TABLE](https://www.postgresql.org/docs/15/sql-createtable.html)
- [PostgreSQL Wiki: Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This)
- [Crunchy Data: Enums vs Check Constraints in Postgres](https://www.crunchydata.com/blog/enums-vs-check-constraints-in-postgres)
- [Cybertec: Lookup Table or Enum Type?](https://www.cybertec-postgresql.com/en/lookup-table-or-enum-type/)
- [Cybertec: Bad CHECK Constraints in PostgreSQL](https://www.cybertec-postgresql.com/en/bad-check-constraints-postgresql/)
- [Cybertec: Broken Foreign Keys in PostgreSQL](https://www.cybertec-postgresql.com/en/broken-foreign-keys-postgresql/)

## Key Findings

1. **`NULL` is not a value, it is the absence of a value.** PostgreSQL's three-valued logic means `NULL = NULL` returns `NULL` (not `TRUE`), `NULL IN (1,2,3)` returns `NULL`, and `NOT (column = 1)` returns `NULL` when `column IS NULL` — not `TRUE`. Every nullable column forces every query against it to reason about three outcomes. Nullable-by-default is the single largest source of silent query bugs.
2. **`NOT NULL` discipline rule:** a column should be nullable ONLY if the absence of the value is a semantically distinct state ("not yet harvested", "awaiting review"). Nullability for "we don't have it yet" on mandatory fields is a data-model smell — either the row shouldn't exist yet, or a separate state column should carry the "pending" semantics.
3. **`NOT NULL` + `DEFAULT`** is a common, correct pattern for audit columns: `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. The default fires on INSERT without value, then NOT NULL ensures every row has a value.
4. **`NOT NULL` violations in production manifest as nullable join results.** A LEFT JOIN introduces nulls even for NOT-NULL columns in the joined table. Queries must still handle null — NOT NULL does not make downstream SQL null-free, but it does eliminate the class of bugs where the column was "supposed" to be set but wasn't.
5. **`CHECK` constraints are cheap and always-on.** They run on every INSERT / UPDATE of the constrained column. They are checked inside the transaction and cannot be violated by concurrent writes. Use them for:
   - Range constraints: `CHECK (quantity >= 0)`, `CHECK (age BETWEEN 0 AND 150)`
   - Enumerated values: `CHECK (status IN ('pending','active','archived'))`
   - Business rules: `CHECK (end_date IS NULL OR end_date >= start_date)`
6. **CHECK on enumerated VARCHAR is the cheap path; PostgreSQL `ENUM` is the strict path.** `CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped')` creates a first-class type, is 4 bytes on disk, and rejects unknown values at the type layer. But adding a value is `ALTER TYPE ADD VALUE`; removing a value is not supported without dropping and recreating the type (plus every column using it).
7. **Check constraint trap:** if the CHECK references a volatile function (e.g., `now()`) or a column that changes, the constraint can become "not equal" after a schema dump and restore. Cybertec warns against CHECK constraints with non-IMMUTABLE expressions. The PostgreSQL planner also cannot prove implications from volatile CHECKs.
8. **Lookup table is the third option.** `status_id REFERENCES statuses(id)` makes new values a data change, not a schema change. Tradeoff: an extra join for display labels, but maximum flexibility. Recommended when the enumeration changes frequently or carries metadata (display color, sort order, is_final).
9. **Foreign key `ON DELETE` must be explicit.** PostgreSQL's default is `NO ACTION`, which is identical to `RESTRICT` for almost all purposes but is deferrable. Silent defaults are wrong more often than right — reviewers should require explicit `ON DELETE` on every FK.
10. **`ON DELETE CASCADE`** is appropriate when the child row cannot exist without the parent: `order_lines` without `orders`, `tenant_config` without `tenants`, `message_attachments` without `messages`. CASCADE is DANGEROUS on tenant root tables — cascading a tenant delete can wipe audit data that must be retained for compliance.
11. **`ON DELETE SET NULL`** is appropriate when the child is a weak reference: `tasks.assigned_to REFERENCES users` — deleting a user unassigns tasks, does not delete them. Requires the FK column to be nullable.
12. **`ON DELETE RESTRICT`** prevents the delete if children exist. Use for independent objects: a customer with open orders cannot be deleted until the orders are handled. RESTRICT surfaces the problem to the application instead of silently cascading.
13. **`ON DELETE NO ACTION`** differs from RESTRICT only by deferrability. For reviewer purposes, treat as synonymous with RESTRICT and still require it to be explicit.
14. **`ON UPDATE`** matters when the parent's primary key can change. For immutable UUID / identity PKs, `ON UPDATE` is effectively dead code — but should still be explicit for self-documentation (`ON UPDATE NO ACTION` or `ON UPDATE CASCADE`).
15. **Default values: database layer vs application layer.** Database defaults survive direct SQL, bulk imports, out-of-band tools, and multiple application clients. Application-layer defaults only fire when the application is the writer.
   - DB layer: invariant defaults — `created_at DEFAULT now()`, `id DEFAULT gen_random_uuid()`, `is_active DEFAULT true`.
   - App layer: context-dependent defaults — "use current user's tenant", "use current request's locale".
16. **Default value traps:**
   - `DEFAULT 'now'` (string) is evaluated at table-creation time and frozen; use `DEFAULT now()` or `DEFAULT CURRENT_TIMESTAMP` (function).
   - `DEFAULT 'true'` (string) may work via implicit cast but is brittle; use `DEFAULT TRUE`.
   - `DEFAULT` on a JSONB column with a mutable object is evaluated once per insert — fine, but non-obvious for reviewers.
17. **Deferrable constraints** (`DEFERRABLE INITIALLY DEFERRED`) let FK and unique checks run at COMMIT instead of per-row. Useful for bulk data loads and circular FK patterns, but makes debugging harder — a failed commit surfaces a constraint violation far from the offending statement. Use sparingly.
18. **Application-enforced "constraints" are not constraints.** A service-layer validation that the app believes is exhaustive will be bypassed by: (a) another service writing to the same table, (b) direct SQL for hotfixes, (c) TypeORM repository calls that skip the validation decorator, (d) raw migrations. If it matters, the DB must enforce it.

## Security Concerns
- Nullable `tenant_id` on a tenant-scoped table = CRITICAL (null rows escape tenant isolation, often visible to all tenants).
- `ON DELETE CASCADE` on a tenant root table that cascades into compliance audit logs = CRITICAL (regulatory data destruction).
- Missing `CHECK` on enumerated status columns allows application bugs to write arbitrary garbage values, poisoning downstream queries and reports.
- Missing `NOT NULL` on `created_by`, `tenant_id`, or other provenance columns = HIGH (audit trail holes).

## Performance Concerns
- Excessive CHECK constraints with expensive predicates (complex regex, cross-row subqueries) = MEDIUM on write-heavy tables.
- Non-IMMUTABLE CHECK constraints = HIGH (planner cannot use them for constraint exclusion, dump/restore may fail).
- Deferrable FK constraints on bulk insert paths = HIGH (constraint check at commit can produce huge lock holds).
- Default expressions that call volatile functions per row (e.g., a randomized UUID default) are fine; default expressions that do table lookups are a silent performance trap.

## Architectural Implications for database-reviewer

- Every new column MUST declare `NOT NULL` unless the reviewer can point to a distinct semantic meaning for "absent". The burden of proof is on the nullable choice.
- Every new column MUST have an explicit `DEFAULT` or a clear reason why not (required on INSERT from the app). `created_at`, `updated_at`, `id` (for UUID PKs) always have DB defaults.
- Every new column representing an enumerated business state MUST use one of: (a) PostgreSQL `ENUM` type, (b) `CHECK (col IN (...))`, (c) `FOREIGN KEY` to a lookup table. Untyped `VARCHAR` / `TEXT` status columns = MEDIUM.
- Every new `REFERENCES` clause MUST declare explicit `ON DELETE` and `ON UPDATE`. Silent `NO ACTION` default = MEDIUM (force the reviewer to think about the semantics).
- `ON DELETE CASCADE` on tenant root tables or compliance tables = HIGH until a data-expert reviews the cascade path and confirms no retention-mandated data is destroyed.
- Application-only "constraints" on anything that affects tenant isolation or financial correctness = HIGH — must be promoted to a database constraint.

## Domain Rule Additions for database-reviewer

Add to `## Domain Rules → Constraint Completeness`:

- `NOT NULL` is the default mental model — every new column must justify nullability. `tenant_id`, `created_at`, `updated_at`, `created_by`, `is_deleted` MUST be NOT NULL on every tenant-scoped table. Missing = HIGH.
- Every column with a set of valid values MUST enforce them via `ENUM`, `CHECK IN (...)`, or FK lookup table. Untyped status strings = MEDIUM.
- `CHECK` constraints MUST use IMMUTABLE expressions only. `CHECK (created_at <= now())` uses STABLE `now()` and will break `pg_dump --schema-only` restore — flag as HIGH.
- Every `REFERENCES` clause MUST declare explicit `ON DELETE` and `ON UPDATE`. Silent default = MEDIUM.
- `ON DELETE CASCADE` on a tenant root, audit, or compliance table = HIGH — require data-expert sign-off.
- `ON DELETE CASCADE` is appropriate only when the child cannot exist without the parent. For independent objects, prefer `RESTRICT` + application-handled workflow.
- `ON DELETE SET NULL` requires the FK column to be NOT NULL-able — flag mismatches as HIGH.
- Database defaults SHOULD be used for invariant columns (`created_at`, `id`, `is_active DEFAULT true`). Application-layer default for these = MEDIUM (bypassable by direct SQL / other services).
- Deferrable FK / unique constraints MUST have a written justification in the migration comment (typically bulk-load or circular FK). Unjustified `DEFERRABLE INITIALLY DEFERRED` = MEDIUM.
- Business rules implemented only in application code (not DB constraint) that affect tenant isolation or financial correctness = HIGH promotion candidate.
