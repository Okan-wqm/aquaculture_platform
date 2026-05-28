# ADR: Farm Persistence Boundary

## Status

Accepted.

## Decision

Business writes in farm-service must execute inside tenant-scoped transactions. The write path is:

`Resolver or Controller -> DTO mapper -> Command or Query -> Handler -> Policy or Aggregate -> Tenant transaction -> Audit and Outbox`

Handlers must not open ad hoc query runners in domain paths. Repository access inside a transaction must come from the tenant manager or a tenant-scoped repository port.

## Integrity Rules

- Domain row, audit row, outbox row, projection update, and mobile receipt commit as one unit.
- Hot paths use stable lock ordering, row locks where needed, bounded retry, and idempotency keys.
- Soft-delete business uniqueness uses active-only partial indexes.
- Restore conflicts return domain errors rather than leaking database errors.

## Allowed Infrastructure Paths

Raw TypeORM infrastructure is limited to database bootstrap, migrations, outbox relay internals, and platform database helpers. New exceptions require ADR evidence.
