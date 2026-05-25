# Farm stock read-model contract alignment

## Context

On 2026-05-25, the main deploy for merge commit
`d19766af500ae805ef26252ab508cf2d5b8edc3e` stopped before service startup in
the `aqua-db-migrate` one-shot container. The failure was in
`AssertFarmStockBatchSnapshotMetadata1800500000000`:

```text
farm_stock_batch_snapshots.batchNumber must be VARCHAR(50), got <NULL>(<NULL>)
```

The migration was intended to protect the TypeORM/runtime contract for
`FarmStockBatchSnapshot.batchNumber`, but it assumed the read-model table was
already present in the currently pinned schema. Production proved a ledger/table
drift case: the migration ledger had advanced past the original read-model DDL,
while the current schema did not expose `farm_stock_batch_snapshots`.

## Decision

Keep the migration name and timestamp because the failed deploy did not record
it in the migration ledger. Change the migration from a pure assertion into a
tenant-relative contract witness:

- If either farm stock read-model table is missing in the current `search_path`,
  re-run `CreateFarmStockReadModel1800400000000.up()` as the DDL owner. That
  migration is idempotent and already owns the table/index/backfill contract.
- Add `batchNumber` only if missing.
- Align `batchNumber` to `VARCHAR(50)` only when all existing values fit.
  Oversized values fail the migration explicitly instead of being truncated.
- Drop `NOT NULL` on `batchNumber` because the entity contract is nullable.
- Assert the final column shape after alignment.

This keeps deploy-time repair inside the migration chain and preserves the
schema-per-tenant model: `db-migrate` pins `search_path` for the farm source
schema and for every `tenant_<uuid>` schema before invoking the same migration.

## Verification

The fix must be validated by GitHub Actions rather than local full builds on the
small server. Required gates:

- `CI - Affected`
- `Database Migration Check`
- `Quality Gates`
- deploy workflow release verification
