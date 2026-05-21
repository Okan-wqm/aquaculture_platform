# Admin Billing Triangle Implementation Record

Date: 2026-05-20
Scope:

- `/admin/billing`
- `/admin/billing/module-pricing`
- `/admin/billing/subscriptions`
- `/admin/billing/invoices`
- `/admin/billing/payments`
- `/admin/billing/discounts`
- `/admin/billing/custom-plans`

## Architectural Decision

`SUPER_ADMIN` is treated as the platform-admin role for these routes.

Billing financial writes must be owned by `billing-service`. `admin-api-service`
is a platform-admin REST facade and must not directly mutate `billing.invoices`
or `billing.payments`. This PR introduces typed NATS request-reply commands for
invoice and payment mutations so the write path runs through billing-service CQRS
handlers.

## Implemented Changes

- Added shared admin billing route manifest:
  - `web/shared-ui/src/authz/admin-billing-routes.ts`
  - Visible routes remain the seven scoped billing links.
  - Hidden child workflows are registered for invoice creation, custom-plan creation, and reports.
- Registered missing admin-panel routes:
  - `/admin/billing/invoices/new`
  - `/admin/billing/custom-plans/new`
  - `/admin/billing/reports`
- Added `BillingReportsPage` using existing invoice, subscription, and payment API totals.
- Converted invoice creation UI from amount-only payload to billing-service-compatible payload:
  - billing address
  - line items
  - period and due date
- Added billing admin command contracts:
  - `request.billing.admin.createInvoice`
  - `request.billing.admin.markInvoicePaid`
  - `request.billing.admin.voidInvoice`
  - `request.billing.admin.recordPayment`
  - `request.billing.admin.refundPayment`
- Enabled NATS microservice transport for `billing-service`.
- Added `BillingAdminNatsHandler` in `billing-service`.
- Added `BillingAdminCommandClientService` in `admin-api-service`.
- Routed admin-api invoice/payment mutations through billing-service commands.
- Routed admin-api subscription plan-change/cancel/reactivate/trial-extension
  mutations through billing-service commands.
- Sanitized frontend billing API actor fields before HTTP body serialization. Existing UI-only legacy arguments are not sent to backend.

## Route Matrix

| Route | Frontend | REST facade | DB write owner | Status |
| --- | --- | --- | --- | --- |
| `/admin/billing` | Existing dashboard | Existing read APIs | Read-only | Existing |
| `/admin/billing/module-pricing` | Existing page | Existing admin APIs | Admin schema | Existing |
| `/admin/billing/subscriptions` | Existing page | Mutations routed via NATS | `billing-service` | Implemented |
| `/admin/billing/invoices` | Existing page + hidden create route | Create/mark-paid/void routed via NATS | `billing-service` | Implemented |
| `/admin/billing/payments` | Existing page | Record/refund routed via NATS | `billing-service` | Implemented |
| `/admin/billing/discounts` | Existing page | Actor fields sanitized in frontend API | Admin schema | Improved |
| `/admin/billing/custom-plans` | Existing page + hidden create route | Actor fields sanitized in frontend API | Admin schema | Improved |

## Remaining Watch Item

Module pricing, discounts, and custom plans use admin-owned schema paths today.
If those tables are later moved under `billing.*`, the same command-boundary
pattern must be applied before any write path is exposed.

## Validation

Passed on 2026-05-20:

- `npx tsc --noEmit -p apps/admin-api-service/tsconfig.app.json`
- `npx tsc --noEmit -p apps/billing-service/tsconfig.app.json`
- `npx tsc --noEmit -p web/modules/admin-panel/tsconfig.json`
- `npx tsc --noEmit -p web/shell/tsconfig.json`
- `npx tsc --noEmit -p web/shared-ui/tsconfig.json`
- Targeted ESLint on changed backend/contracts/shared-ui/admin-panel/shell files: no errors. Existing warning-only rules remain.

## Deployment Note

The observed GHCR build log showed the immutable SHA image push completed, while
the `latest` tag push failed due a GitHub authzd/Twirp internal authorization
request failure. Deployment should prefer immutable SHA tags; `latest` should be
retried separately and must not be the only deployment reference.
