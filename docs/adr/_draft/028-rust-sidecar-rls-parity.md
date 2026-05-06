# ADR-028: Rust Sidecar RLS Parity — Defense-in-Depth Tenant Isolation

**Status:** Proposed
**Date:** 2026-04-22
**Deciders:** platform team, security team, sensor-service owner
**Related:** ADR-011 (schema ownership), ADR-008 (guard strategy defense-in-depth), SEC-M16 (tenant-scoped cache key), Rust plan `snappy-sniffing-pine.md` Kör Nokta 1

## Context

NestJS services enforce tenant isolation at three layers: (a) schema-per-tenant (`tenant_<hex>` schema), (b) `getScopedRepository()` in TypeORM which issues `SET LOCAL app.current_tenant = $1` on every transaction, and (c) RLS (Row Level Security) policies that filter by `current_setting('app.current_tenant')::uuid`. CLAUDE.md elevates this to "defense-in-depth" — a single-layer bypass does not breach isolation.

`apps/sensor-ingestion/src/persistence.rs` uses `tokio-postgres` directly: `COPY ... FROM STDIN BINARY` → `batch_execute(upsert_sql + truncate_sql)`. No `SET LOCAL app.current_tenant` is issued. Today isolation is preserved **only by the schema name** (derived from `SchemaName::from_tenant(tenant_id)`), which is layer (a) alone. A future regression — a `SchemaName::from_raw(user_input)` backdoor, a parser bug that mis-derives the schema, or a cross-schema query by a future control-plane feature — would not be caught by layer (b) or (c) because neither is active on the Rust path.

The audit matched every assumption to file:line and the gap is verified. The fix must be architectural (CLAUDE.md), not a runtime check in application code.

## Decision

The Rust sidecar achieves **TS parity** on tenant isolation: every transaction sets the RLS context, and RLS policies apply to the tables it writes.

### Application layer

1. `crates/tenant-context/src/scoped_tx.rs` exposes `ScopedTx<'t>` — a wrapper around `tokio_postgres::Transaction` that:
   - Is constructed only from a `Scoped<'t, SchemaName>` value (PhantomData lifetime branding).
   - At construction time executes `SELECT set_config('app.current_tenant', $1, true)` — `true` = LOCAL to the transaction.
   - Exposes the query API to callers; never exposes the raw `Transaction`.

2. `persistence.rs::write_tenant_batch` only accepts `ScopedTx`. Compilation fails if a caller tries to invoke it with a bare `Transaction`.

3. The `tenant-context` crate forbids re-exporting the raw Transaction type; the module boundary is the enforcement surface.

### Database layer

Migration `V017__rls_sensor_metrics.sql` (bidirectional):

```sql
-- up
ALTER TABLE sensor.sensor_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensor.sensor_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sensor.sensor_metrics
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE sensor.sensor_metrics_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensor.sensor_metrics_stage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sensor.sensor_metrics_stage
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- down
DROP POLICY tenant_isolation ON sensor.sensor_metrics_stage;
ALTER TABLE sensor.sensor_metrics_stage NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sensor.sensor_metrics_stage DISABLE ROW LEVEL SECURITY;
DROP POLICY tenant_isolation ON sensor.sensor_metrics;
ALTER TABLE sensor.sensor_metrics NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sensor.sensor_metrics DISABLE ROW LEVEL SECURITY;
```

`FORCE ROW LEVEL SECURITY` ensures the policy applies to table owners too — the sensor-ingestion DB role does not get a bypass even if it owns the table.

### Failure mode

A write path that forgets `SET LOCAL app.current_tenant` (by constructing a `ScopedTx` incorrectly or by bypassing the wrapper) hits the RLS policy and PG returns 0 rows affected / `new row violates row-level security policy for table "sensor_metrics"`. The sidecar translates this to `SinkError::InvalidRow { reason: "tenant context not set — RLS rejected write" }` and the batch fails closed.

## Consequences

**Positive:**
- Three-layer defense matches TS path; a single-layer regression does not breach isolation.
- Compile-time enforcement (PhantomData branding) prevents accidental bypass.
- RLS failure is loud (error on write) rather than silent (wrong-tenant data).

**Negative:**
- Every `write_tenant_batch` pays one extra round-trip (`SET LOCAL app.current_tenant`). Amortized over 10K-row batches → sub-millisecond overhead per batch; negligible vs. COPY duration.
- Migration V017 is bidirectional but requires DB role permission to `ENABLE ROW LEVEL SECURITY`. Deploy runbook must verify the role owns `sensor.sensor_metrics`.
- Test suites that write to `sensor.sensor_metrics` without the wrapper (legacy fixtures) will fail after V017 — must be converted.

**Neutral:**
- `current_setting('app.current_tenant', true)::uuid` with the `true` (missing_ok=true) flag returns NULL when unset; policy `USING (tenant_id = NULL)` evaluates to NULL → row excluded. INSERT without set returns `new row violates RLS policy`. The sidecar and tests can rely on this consistent "closed" behavior.

## Alternatives Considered

1. **Runtime guard in application code** — rejected. Application-layer checks (`if tenant_id.is_none() { bail!() }`) are bypassable by a future refactor; the type system + DB policy are not.
2. **Per-tenant DB role** — rejected. 50K tenant × per-tenant role explodes PG role cardinality and breaks connection pooling.
3. **Schema-derived policy without SET** — infeasible. RLS policy can reference `current_schema()` but not map `current_schema()` to `tenant_id` without a lookup function; the `SET app.current_tenant` approach is the canonical PG pattern.

## Verification

- `cargo test -p sensor-ingestion --test rls_context_invariant`
  - `persistence_rejects_write_without_tenant_context()` — bare Transaction in test harness → COPY fails with RLS error.
  - `scoped_tx_sets_current_tenant_on_construction()` — spy on PG `SELECT current_setting('app.current_tenant')`.
- Integration test with testcontainers TimescaleDB: apply V017, attempt COPY without SET → error; apply SET + COPY → success.
- `psql -c "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname LIKE 'sensor_metrics%';"` returns `t, t` for both rows after V017 applies.
- Schema drift validator (ADR-012) adds RLS policy presence check — boot fails if V017 is missing in an expected environment.
