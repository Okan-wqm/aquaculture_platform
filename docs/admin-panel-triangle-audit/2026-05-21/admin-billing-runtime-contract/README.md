# Admin Billing Runtime Contract Fix - 2026-05-21

## Scope

This record covers the live runtime failure on the platform-admin billing pages:

- `/admin/billing`
- `/admin/billing/subscriptions`
- `/admin/billing/invoices`
- `/admin/billing/payments`

## Live Findings

- `GET /api/billing/invoices?...` and `GET /api/billing/subscriptions?...` returned HTTP 500 in production.
- `aqua-admin-api` logs showed PostgreSQL `operator does not exist: text = uuid`.
- The failing read-model joins cast `auth.tenants.id` to `text` while production `billing.invoices.tenant_id` and `billing.subscriptions.tenant_id` are UUID.
- `aqua-billing` logs showed NATS subscription permission violations for `request.billing.admin.*`, so the intended billing-service write boundary could not receive admin mutation commands.

## Architectural Decision

Tenant identity remains UUID across auth and billing schemas. Admin-api may expose platform-admin REST read/facade endpoints, but it must not force billing tenant IDs through text joins. Billing-service owns billing mutations, and admin-api must enter writes through the audited billing admin command subjects.

## Fix

- Replaced admin billing tenant joins with UUID-native joins: `auth.tenants.id = billing.<table>.tenant_id`.
- Cast tenant and invoice filter bind parameters to `::uuid` where admin-api accepts string route/query input.
- Added `request.billing.admin.>` to the billing-service NATS subscribe ACL in the SSoT.
- Regenerated `infrastructure/docker/nats/nats.conf` from `infrastructure/nats/services.yaml`.
- Added an invariant test that fails on text-cast tenant joins and on missing billing admin command NATS ACLs.

## Validation

Validation commands are recorded in the PR once run:

- `./scripts/nats/generate-nats-conf.py`
- `npx jest --config tests/invariants/jest.config.ts --runTestsByPath tests/invariants/admin-billing-runtime-contract.spec.ts --runInBand`
- `npx tsc --noEmit -p apps/admin-api-service/tsconfig.app.json`
