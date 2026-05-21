# Admin Billing Triangle Review - 2026-05-20

Scope was limited to the platform-admin billing surface:

- `/admin/billing`
- `/admin/billing/module-pricing`
- `/admin/billing/subscriptions`
- `/admin/billing/invoices`
- `/admin/billing/payments`
- `/admin/billing/discounts`
- `/admin/billing/custom-plans`

## ADMIN-HIGH-001 - Admin billing routes exposed workflows that backend and database ownership did not carry end to end

**State:** OPEN

The admin billing frontend exposed invoice creation and billing dashboard links that were not backed by a registered admin route and a billing-service-owned write path. The deeper architectural issue was that `admin-api-service` directly mutated `billing.invoices`, `billing.payments`, and `billing.subscriptions`, even though billing-service is the financial source of truth.

Evidence:

- `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx` linked invoice creation and reports paths that were not registered in the admin module route table.
- `web/modules/admin-panel/src/services/api/billing.ts` sent invoice creation payloads that did not match the billing-service invoice command contract.
- `apps/admin-api-service/src/billing/billing.controller.ts` accepted platform-admin billing mutations through admin-api.
- `apps/admin-api-service/src/billing/services/invoice-management.service.ts`, `apps/admin-api-service/src/billing/services/payment-management.service.ts`, and `apps/admin-api-service/src/billing/services/subscription-core.service.ts` performed direct financial writes against billing-owned tables.

Required resolution:

- Make the frontend route manifest, shell navigation, remote module route table, and backend capabilities converge for the scoped links.
- Keep platform-admin authorization at the shell, admin-panel, and backend guard layers.
- Route invoice, payment, and subscription mutations through billing-service-owned command handlers instead of admin-api direct table writes.
- Preserve date-stamped implementation documentation under `docs/admin-panel-triangle-audit/2026-05-20/admin-billing/`.
