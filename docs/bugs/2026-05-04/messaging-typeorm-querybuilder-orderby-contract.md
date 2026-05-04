# Messaging TypeORM QueryBuilder Order Contract

Date: 2026-05-04

## Problem

GitHub Actions `E2E Messaging` caught a runtime failure in offline sync and GDPR export:

```text
TypeError: Cannot read properties of undefined (reading 'databaseName')
```

The failing paths used TypeORM entity `QueryBuilder` with `leftJoinAndSelect(...)`, pagination via `take(...)`, and quoted SQL order criteria such as `m."createdAt"` and `m."id"`.

## Root Cause

TypeORM rewrites joined paginated entity queries and maps `orderBy` fields through entity metadata. In that API contract, order criteria for entity columns must be property paths such as `m.createdAt` and `m.id`. SQL-quoted identifiers are valid in raw `where` expressions, but they are not valid entity property paths for the order mapping step.

## Enterprise Fix

All messaging entity `QueryBuilder` order paths for the `Message` alias now use TypeORM property paths:

- `m.createdAt`
- `m.id`
- `m.channelId`

Raw SQL predicates remain quoted where they are actual SQL expressions. This keeps tenant predicates explicit while aligning ordering with the ORM contract.

## Covered Paths

- Offline single-channel sync
- Offline all-channel sync
- GDPR message export pagination
- Message list pagination
- Message search secondary ordering
- Channel latest-message preloading
- AI chat context reads

## Validation

Required validation after this change:

- Messaging app typecheck
- Messaging spec typecheck
- Messaging tenant-routing gate
- Targeted message/GDPR tests
- GitHub Actions `E2E Messaging`

## Prevention

Future entity `QueryBuilder` code should treat `where(...)` and `orderBy(...)` as different contracts:

- Use SQL expressions in `where(...)` only when needed.
- Use entity property paths in `orderBy(...)` and `addOrderBy(...)` for entity columns.
