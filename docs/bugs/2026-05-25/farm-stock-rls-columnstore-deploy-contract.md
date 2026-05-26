# Farm Stock RLS Columnstore Deploy Contract

## Date

2026-05-25

## Failure

Main deploy failed during `db-migrate` while running
`ExtendFarmStockReadModelFanout1800600000000` against an existing tenant schema:

```text
operation not supported on hypertables that have columnstore enabled
```

The migration had finished the farm read-model DDL/backfill, then called the
generic `applyTenantRlsToSchema` helper without a table scope. In a
`tenant_<uuid>` schema that helper discovered tables owned by every
schema-per-tenant service, including TimescaleDB columnstore hypertables such
as telemetry tables. PostgreSQL/TimescaleDB rejected the RLS DDL on those
columnstore hypertables, so the farm migration failed for a cross-service
table it did not own.

## Architecture Decision

Farm-service migrations must scope RLS installation to the tables they own.
`ExtendFarmStockReadModelFanout1800600000000` now passes `includeTables` for:

- `farm_stock_container_snapshots`
- `farm_stock_batch_snapshots`
- `farm_mobile_command_receipts`

The shared RLS helper also understands TimescaleDB columnstore capability. In
tenant schemas only, columnstore/compressed hypertables are skipped with an
operator-visible warning because the tenant schema boundary is the primary
isolation boundary for those physical tables and the platform cannot safely
run the RLS DDL while columnstore is enabled. Shared schemas remain fail-closed
unless a caller explicitly opts in.

## Validation Contract

- The farm migration postcondition verifies RLS is enabled and forced on all
  three farm-owned tables.
- Unit coverage verifies `includeTables` constrains discovery parameters.
- Unit coverage verifies tenant-schema columnstore hypertables are skipped
  without suppressing RLS on normal tenant tables.
- The implementation remains TypeScript-only and does not use `any` or
  lint-suppression comments.
