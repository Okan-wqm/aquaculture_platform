# Farm Stock Snapshot GraphQL Contract

## Context

The `2026-05-25` production deploy for merge commit
`f2345ee8123d1e42f5e8c1db1260c437e8eb5f90` completed database migration
successfully, but failed the critical service health gate.

The deploy log showed `aqua-farm` restarting during bootstrap with:

```text
Undefined type error. Make sure you are providing an explicit type for the "batchNumber" of the "FarmStockBatchSnapshot" class.
```

`aqua-gateway` then failed supergraph composition because the farm GraphQL
endpoint was unavailable. The gateway failure was a downstream symptom, not the
root cause.

## Resolution

Farm stock snapshot read-model entities now declare explicit GraphQL field type
functions for nullable fields whose TypeScript design metadata can reflect as
`Object`, especially `string | null` and `Date | null` fields.

This keeps the GraphQL schema contract deterministic and aligned with the
TypeORM column contract instead of relying on runtime reflection for nullable
union properties.

## Guardrail

The farm stock snapshot metadata test now loads Nest GraphQL lazy metadata for
the snapshot entity set. This exercises the same metadata path used during
service bootstrap and catches reflected `Object` field regressions before
deployment.
