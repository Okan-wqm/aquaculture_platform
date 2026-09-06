# SUPER_ADMIN Panel Audit — Remediation Architecture — 2026-09-05

- **Scope:** `web/modules/admin-panel` (50 pages), `apps/admin-api-service` (34 controllers, 603 routes), the `admin` schema, and the ingress / kernel / billing / auth seams they depend on.
- **Method:** 5 phases, 24 agent runs (Phase 0 inventory → 1a/1b/1c correctness → 2 security → 3 quality → 4 synthesis → 5a architectural-arbiter). Every CRITICAL claim was re-verified by grep against the repository before it was relayed. Read-only audit; no code changed in the audit itself.
- **Directive of record (owner, 2026-09-05):** no patches. Every remediation is a Tier-1/Tier-2 architectural fix that carries a Tier-3 CI gate and is tested unit + integration + contract + e2e + invariant. Findings are not fixed one button or one field at a time.
- **Registry:** the 26 umbrella findings below are appended to `docs/reviews/_registry/findings.jsonl` (cycle `2026-09-05-superadmin-audit`). Every remediation commit carries a `Closes:` trailer pointing at one of them.
- **Arbiter ADRs:** `docs/recommendations/architectural-arbiter/2026-09-05-adr-0006-…` through `-adr-0017-…`.

## 0. Türkçe Özet

50 sayfanın **hiçbiri** eksiksiz çalışmıyor: 15 DEGRADED, 16 BROKEN, 18 FAKE. Sayfaların bir katman altında 41 UI aksiyonu, 118 client fonksiyonu ve 168 backend route ölü. Kanonik bulgu sayısı 56 CRITICAL + 56 HIGH; bunlar 17 kök neden kümesine ve 12 hakem kararına indirgendi.

Ana bulgu: ADR-002 "tek internet girişi gateway-api" diyor; nginx `/api/` isteklerini doğrudan admin-api-service'e yönlendiriyor. Erişim logu, iç başlık temizleme, act-as, MFA step-up ve kara liste guard'ı admin yüzeyinin girişi olmayan serviste monte edilmiş. Impersonation, MFA, yetki modeli ve edge sertleştirme kararlarının dördü de bu tek çelişkiden türüyor.

Üretimde çalışan yedek yok. Her iki admin projesi CI'da hem lint hem test karantinasında; hiçbir gate PR'da çalışmıyor. Tenant oluşturma NATS ACL eksikliği yüzünden her seferinde 502 veriyor.

## 1. Headline

| dimension                   | result                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Pages                       | 50 audited: WORKS **0**, DEGRADED 15, BROKEN 16, FAKE 18, unresolved 1                                                                  |
| Verdict                     | FIX 23, REBUILD 18, DELETE 8                                                                                                            |
| Dead surface one layer down | 41 UI actions, 118 client functions, 168 backend routes                                                                                 |
| Canonical findings          | 56 CRITICAL + 56 HIGH (SA-001…SA-115) + 118 MEDIUM/LOW in 14 classes                                                                    |
| Root-cause clusters         | 17 (C1–C17)                                                                                                                             |
| Arbiter rulings             | ARCH-CRITICAL-000 + R1–R12; factual conflicts C1–C7 resolved                                                                            |
| Tests actually run          | admin-api-service 920 pass / 39 skip; admin-panel 132 pass; coverage 31.66% statements; both projects quarantined from CI lint AND test |
| Production backups          | none functional                                                                                                                         |

## 2. Findings (registry IDs) → architectural fix → gate

Each finding is an umbrella for one systemic root cause. The fix is the Tier-1/2 mechanism; the gate is the Tier-3 CI assertion that makes regression fail a PR. Ruling numbers (Rn) refer to the arbiter ADRs; cluster numbers (Cn) to the Phase-4 synthesis.

## SEC-CRITICAL-056 — Two internet-reachable ingresses; kernel edge controls mounted on the wrong one (ARCH-CRITICAL-000, R11)

**State:** OPEN · **Wave:** W1 · **ADR:** 0006 (supersedes ADR-002 in part)

`infrastructure/nginx/droplet.conf:423-433` proxies `/api/` straight to admin-api-service. `tests/invariants/strip-internal-headers-mounted.spec.ts:75-79` excludes admin-api behind a `// Future:` comment; `access-log-middleware-mounted.spec.ts:20-21` calls gateway-api the single ingress. `TRUST_PROXY` defaults to `'false'` and admin-api never sets it, so every `byIp` rate-limit bucket is one global bucket.

**Fix (Tier-1 + Tier-2):** `bootstrapService` applies an edge-hardening bundle (StripInternalHeaders, AccessLog, RequestContext, required `TRUST_PROXY`) to every service declaring `serviceVisibility: 'public'`. The public set is derived from `droplet.conf` upstreams, never hand-listed. The two mount invariants are merged and their hand lists deleted. Dead CSRF middleware is deleted platform-wide.
**Gate:** `tests/invariants/public-service-edge-hardening.spec.ts` parses nginx and asserts each proxied upstream boots with the bundle and sets `TRUST_PROXY` in the droplet compose.
**Depends on:** DATA-CRITICAL-013 (retention) — mounting AccessLog on admin-api without a working `shared.access_logs` policy grows an unbounded table.

## SEC-CRITICAL-057 — Impersonation is decorative (R1)

**State:** OPEN · **Wave:** W2 · **ADR:** 0007

Zero occurrences of `impersonat*` in gateway-api. The minted token has no consumer. `admin.impersonation_sessions` carries a blanket `BEFORE UPDATE OR DELETE` refusal trigger (`1800000000000-Baseline.ts:266-277`) that six service paths violate. `EffectiveTenantMiddleware` already enforces the whole control set (UUID, tenant ACTIVE fail-closed, MFA step-up, HMAC-bound effective tenant).

**Fix (Tier-1):** delete the module (controller, service, entities, tables, page, client, CORS header, and the debug-tools sub-module under it). Promote `EffectiveTenantMiddleware` + `CaptureRequestedTenantMiddleware` into `libs/backend-common/src/middleware/`; mount on every public ingress. Reason and ticket move to `X-Act-As-Reason` / `X-Act-As-Ticket`, persisted in `shared.audit_logs` (`actorHomeTenantId`, `actedOnTenantId`, `mfaVerified`).
**Gate:** `tests/invariants/cross-tenant-authority-ssot.spec.ts` — exactly one act-as implementation repo-wide, mounted on every nginx-derived ingress, zero `impersonation_session` references outside migrations.

## SEC-CRITICAL-058 — No MFA model for platform admins (R5)

**State:** OPEN · **Wave:** W3 · **ADR:** 0011 (cutover clause `proposed` — human decision)

**Fix:** auth-service `TokenService` refuses to mint a `SUPER_ADMIN` access token for a user without `mfaEnabled` (Tier-1). Step-up for cross-tenant (existing, `effective-tenant.middleware.ts:186-192`) and for irreversible operations via `@Destructive({ requiresFreshMfa: true })` + `DestructiveActionGuard`. `security.mfa_enabled` config key and `impersonation_sessions.mfaCompleted` are deleted.
**Gate:** `tests/invariants/platform-admin-mfa-ssot.spec.ts` — mint refusal asserted as unit behaviour; every `@Destructive({irreversible})` route resolves through the guard; no `MFA_REQUIRED_FOR_CROSS_TENANT=false` in any committed env; zero readers of `mfa_enabled`.
**Human decision required:** enrolment cutover date (`SUPER_ADMIN_MFA_ENFORCED_AT`) and the locked-out-operator break-glass procedure.

## SEC-HIGH-059 — Single SUPER_ADMIN bit is the whole authorization model (R10, C6)

**State:** OPEN · **Wave:** W3 · **ADR:** 0016

**Fix:** `auth.platform_capability_grants` projected into a `platformCapabilities` JWT claim at mint (same path as `modules` / `resourcePermissions`; revocation rides the existing durable token invalidation). Closed enum `billing-ops | support-ops | security-ops | platform-read-only | break-glass` (≤ 4 h, fresh MFA). `@RequiresCapability` + `PlatformCapabilityGuard` as the third `APP_GUARD`, ANDed after an untouched `PlatformAdminGuard`, so a grant can never widen. `@Destructive({scope, dualControl, dryRunDefault, requiresTypedConfirmation})` + `destructive_runs` WORM ledger modelled on `cleanup_runs`.
**Gate:** `tests/invariants/platform-capability-coverage.spec.ts` — every mutating admin route carries a capability via reflected metadata; ratcheting allowlist `{route, owner, expiry, findingId}`.

## SEC-HIGH-060 — IP access rules enforced by nothing (R4)

**State:** OPEN · **Wave:** W3 · **ADR:** 0010

**Fix (Tier-1):** delete both stacks — gateway `IpWhitelistGuard` (unregistered, fail-open, IPv4-only, in-memory Map with no writer) and `admin.ip_access_rules` + controller + service + entity + page + client. IP restriction, if required, is an nginx `allow`/`deny` block.
**Gate:** `tests/invariants/no-dead-guards.spec.ts` — every `CanActivate` in `apps/**` and `libs/**` is an `APP_GUARD`, in a `@UseGuards()`, or allowlisted with `{owner, expiry, reason}`.

## SEC-HIGH-061 — Login rate-limit tier keyed to REST paths while login is a GraphQL mutation (SA-009)

**State:** OPEN · **Wave:** W0

`rate-limit.config.ts:66` binds the login tier to `/api/auth/login` and `/auth/login`. Authentication is a GraphQL operation, so the tier never engages.
**Fix:** the tier is bound to the GraphQL login operation name resolved from the parsed document, sharing one declaration with the auth-service resolver; `TRUST_PROXY` becomes required for public services (SEC-CRITICAL-056).
**Gate:** invariant that every rate-limit tier path or operation resolves to a registered route or GraphQL operation.

## DATA-CRITICAL-012 — PROTECTED_TABLES misclassification; phantom ADR-018 (R2, C7)

**State:** OPEN · **Wave:** W2 · **ADR:** 0008 (creates the missing `018-protected-tables-ssot` record)

**Principle (binding):** a table is listed iff it is write-once at row granularity AND physically carries `id` + `legalHold`. Column-scoped triggers are rejected; mutable aggregates are split into a lifecycle row plus append-only event rows (`cleanup_runs` / `cleanup_run_events` precedent).
**Fix:** remove `admin.impersonation_sessions` with its drop; add `admin.activity_logs` and `admin.tenant_activities` (legalHold, canonical two triggers, `performedBy NOT NULL` blue-green); add the 10 missing mandatory columns to `admin.audit_logs`.
**Gate:** `tests/invariants/audit-immutability-triggers.spec.ts` iterates `PROTECTED_TABLES` and asserts legalHold, both triggers, and that no repository `.save`/`.update` in the fleet targets a listed entity.

## DATA-CRITICAL-013 — Three retention engines; the compliance window has never executed (R6, C10)

**State:** OPEN · **Wave:** W1 · **ADR:** 0012 (promotes ADR-024 to Accepted)

`retention-bootstrap.module.ts:58,97` register `timestampColumn: 'created_at'`; the physical column is `"createdAt"`, so the 7-year and 90-day policies raise and are swallowed. `audit-trail.service.ts:807-866` is a second 03:00 engine with no legal hold and no `@Min`. Eight ad-hoc crons dispose outside any registry.
**Fix (Tier-1):** `RetentionEnforcementService` is the single owner. Delete runtime CRUD, `admin.retention_policies`, `RetentionPoliciesPage` and the eight crons. `registerRetentionPolicy<T>({ entity, timestampProperty: keyof T })` derives schema, table and column from `EntityMetadata`, so a wrong column name cannot compile. `legalHoldClause` is required whenever the entity carries `legalHold`.
**Gate:** `tests/invariants/retention-authority-ssot.spec.ts` — one retention cron in the fleet; every protected table with a policy has a legal-hold clause; every timestamped table in `MODULE_SCHEMAS` has a policy or an allowlisted `{owner, expiry, reason}` entry.

## INFRA-CRITICAL-140 — No functional production backup (R3, C12/C15)

**State:** OPEN · **Wave:** W1 · **ADR:** 0009

**Fix (Tier-1):** WAL-G + `tools/scripts/database/*` is the sole backup and restore authority. Delete the admin-api backup subsystem (service, controller, 3 entities, `admin.schema_backups`, `admin.schema_restores`, 3 crons, backup/restore/PITR UI); re-point `fk_cleanup_runs_backup` at the WAL-G epoch; strike `database-restore-drill.md:548`.
**Gate:** single-authority assertion in `tests/invariants/backup-restore-verification-contract.spec.ts` — nothing outside `tools/scripts/database/` and the two DR workflows may spawn `pg_dump`/`pg_restore` or declare a backup cron.
**Sequencing:** gates every destructive migration in this plan.

## INFRA-CRITICAL-143 — nginx and service route tables disagree on five production paths

**Evidence:** `infrastructure/nginx/droplet.conf` forwarded `/api/upload/*` verbatim to a gateway serving `/api/v1/upload/*`; `/api/csp-report` to a controller at `/api/v1/api/csp-report`; `/install/*` and `/api/devices/*` (installer script + Rust edge agent) to a sensor service serving them under `/api/v1`; `/api/v2/ai/*` to a proxy that never existed; and the SCADA websocket path `/scada-ws/` the client and sensor agreed on had no nginx location. Surfaced while closing the W0 open item on the upload path.

**Fix:** nginx rewrite for uploads; gateway prefix exclusion `api/csp-report`; sensor prefix exclusions `install/*`, `api/devices/*`; dead v2 proxy location, validator route, empty module and unregistered `api/v1/sensors` proxy deleted; `/scada-ws/` websocket location to sensor-service.

**Gate:** `tests/invariants/nginx-route-resolution.spec.ts` derives the nginx location table and every public service's served route table from source and asserts both directions; Docker-internal unprefixed routes are declared with a reason in `.claude/allowlists/internal-only-http-routes.yaml`.

## INFRA-HIGH-141 — CI quarantine policy is ungoverned prose (R12)

**State:** OPEN · **Wave:** W0 · **ADR:** 0017

**Fix (Tier-1 in the consumer):** every `knownUnstableProjects` value becomes `{ owner, expiry, findingId, reason }`; `write-affected-target-report.mjs` exits 1 on a malformed, expired, unknown-finding or RESOLVED-finding entry. The test quarantine of admin-api-service and admin-panel is lifted immediately on measured evidence. Per-spec quarantine only; lint ramp admin-panel first; coverage baselines untouched in the same PR.
**Gate:** the consumer itself, plus `tests/invariants/ci-quarantine-schema.spec.ts` so an expired entry fails a normal PR even when the affected set omits the project.

## INFRA-HIGH-142 — Production is fail-closed by accident (SA-068, C15)

**State:** OPEN · **Wave:** W0

`ENABLE_DEBUG_TOOLS`, `ENABLE_DB_EXPLORER_WRITES`, `ENABLE_RAW_SQL_EXPLORER`, `DATABASE_READONLY_USER`, `BACKUP_ENCRYPTION_KEY` and admin-api `TRUST_PROXY` are absent from `docker-compose.droplet.yml`; nothing pins their absence or presence.
**Fix:** a declared per-service environment manifest (required / forbidden / pinned-false), asserted at boot and diffed against the droplet compose by an invariant. A subsystem that cannot function without a variable refuses to start.

## BILLING-CRITICAL-002 — Two plan catalogues; money in jsonb (R7, C10)

**State:** IN-PROGRESS · **Wave:** W4 · **ADR:** 0013 (extends ADR-037; reverses the `apps/billing-service/CLAUDE.md` ownership clause)

All four tables have moved (discount codes, module pricing, the plan catalogue, custom plans). What remains under this ID is the `PlanPricing` snapshot shape, re-attributed to BILLING-CRITICAL-003 — see the closing note below.

**Fix (Tier-1):** `billing.plans` is the sole catalogue of record for plan id, price, cycle and Stripe ids. Delete `admin.plan_definitions`, `module_pricing`, `custom_plans`, `discount_codes`; migrate their data into billing with `numeric(12,2)` + `CHECK`, ISO-4217 currency, `discountPercent BETWEEN 0 AND 100`. Admin keeps authoring and forwards commands.
**Gate:** `tests/invariants/plan-catalog-ssot.spec.ts` — no plan/price/discount entity outside billing; no money-typed field inside `jsonb`/`simple-json` fleet-wide; Stripe ids in exactly one entity.

**Implementation note — the discount catalogue (landed 2026-09-06):** the first of the four tables has moved. `billing.discount_codes` and `billing.discount_redemptions` are created by `apps/billing-service/src/database/migrations/1802000000000-CreateDiscountCatalogue.ts`, which also copies the `admin` rows; `apps/admin-api-service/src/migrations/1808900000000-RetireAdminDiscountCatalogue.ts` then re-verifies every source row by id in billing and RAISES rather than dropping if one is missing (`SCHEMA_REGISTRY` runs billing at slot 8 and admin at slot 11, so the copy always precedes the drop). `MODULE_SCHEMAS` and the tenant-erasure registry moved with them — a redemption is erased by `tenant_id`, the code itself is platform reference data.

The value model is the part worth stating. `admin.discount_codes.discountValue` was one `numeric(10,2)` holding a percentage for one row and an amount of money for the next, so no CHECK could constrain it (`150` was a legal 150% and a legal $150 at once) and the two non-monetary kinds had nowhere to put their number — `calculateDiscountAmount` returned a silent `0` for `free_months` and `free_trial_extension`, so a "2 months free" code reported success and discounted nothing. Each kind now has its own column (`percent_off numeric(5,2)`, `amount_off` via the platform `MoneyColumn`, `free_months`, `trial_extension_days`) under one CHECK asserting that exactly the matching one is populated, with ISO-4217 `currency` and `CHECK (current_redemptions <= max_redemptions)` so the database refuses an over-redemption even if code races. **Deviation from ADR-0013, deliberate:** the ADR specified `numeric(12,2)`; money uses `MoneyColumn` (`numeric(19,4)`), which is the platform's money SSoT — introducing a second money precision inside `billing` would be the drift the finding is about — and a percentage, not being money, gets `numeric(5,2)`, the widest column that cannot hold a nonsense rate. The contract mirrors the split as a discriminated union (`BillingDiscountValue` in `libs/event-contracts/src/billing-admin-commands.ts`), so a mixed payload does not typecheck, and every amount crosses the wire as an exact decimal string.

Two real defects were fixed rather than carried across. The redemption path had a TOCTOU: it validated, inserted a redemption, then read-modify-wrote `currentRedemptions`, so two requests racing on the last remaining use both passed and both redeemed; `DiscountCodeService.apply` now takes the code row `FOR UPDATE` before asking any rule, so concurrent redeemers of one code serialise. And `appliesTo` had two decorative members: `upgrades_only` and `new_subscriptions_only` were never checked anywhere, so both permitted every redemption, and `specific_plans` was only checked when a plan happened to be named. The rule is now "a restriction that cannot be evaluated REFUSES" — the caller states a `subscriptionChange` (`new` / `upgrade` / `other`) or the restricted code is refused.

Seven commands (`request.billing.admin.{create,update,deactivate,bulkCreate,generate,validate,apply}DiscountCode*`) carry the writes; admin-api holds only read-only external entities (`schema: 'billing'`, `synchronize: false` — the contract `apps/admin-api-service/CLAUDE.md` states) and forwards. A code refused by a rule comes back as `success: true, valid: false` with a typed reason, so the panel renders "expired" instead of a 502. `PricingCalculatorService` stopped re-implementing the arithmetic and validating against a fabricated `'system-quote'` tenant: it asks billing for the amount, and a `discountCode` quoted without a tenant is refused rather than previewed against nobody. Both the OpenAPI artifact and the admin-panel client were regenerated; the ten discount routes are `$ref`-typed on both sides and `services/types/billing.ts` now derives `DiscountCode`, `DiscountAppliesTo` and `DiscountDuration` from the contract (the last two were nominal TypeScript enums, the same class of drift as `DiscountType` in W3).

**Gate:** `tests/invariants/plan-catalog-ssot.spec.ts` — a catalogue table has exactly one writable entity and it is in `billing`; a migrated table leaves no `admin` declaration behind, in the entities or in `MODULE_SCHEMAS`; the discount catalogue holds no money inside jsonb; every remaining money-in-jsonb site on the billing surface and every duplicated Stripe identifier is governed by `.claude/allowlists/money-in-jsonb.yaml` (owner + expiry + finding + reason, ceiling 24, entries only shrink). Deliberately NOT fleet-wide: a name-based money detector cannot tell `totalFeedGiven` (kilograms) from `totalAmount` (currency), so running it over farm-service would be a heuristic dressed as an invariant; the billing surface is where the words mean money and is the surface this finding is about.

**Still open under this finding (owner okan, deadline 2026-12-31):** `admin.plan_definitions`, `admin.module_pricing` and `admin.custom_plans` have NOT moved — they follow the same template in W4b, and the twenty-four allowlist entries plus the four duplicated Stripe identifiers are the machine-readable list of what that wave removes. `billing.plans.pricing` is still a jsonb price matrix (four of those entries); normalising it into per-cycle rows is part of the same wave.

**Implementation note — the module price sheet and the quote (landed 2026-09-06):** the second of the four tables has moved, and the arithmetic moved with it. `billing.module_prices` + `module_price_metrics` + `module_price_tier_multipliers` replace `admin.module_pricing`, whose `pricingMetrics` and `tierMultipliers` were two `jsonb` columns of `number`s: no CHECK could reach a negative price or a tier multiplier of 40, a duplicate metric on one sheet was representable, no index could reach a price, and every arithmetic step ran on doubles because a jsonb number IS one. Now a sheet is a row, each metric is a row with `numeric(19,4) CHECK (price >= 0)` and a `metric_type` CHECKed against the fifteen the contract declares, and each tier multiplier is a row with `numeric(6,4) CHECK (multiplier > 0 AND multiplier <= 10)`. Migrations: `1802100000000-CreateModulePriceSheet` expands the jsonb arrays with `jsonb_array_elements` / `jsonb_each_text` and aborts on anything it cannot represent exactly; `1809000000000-RetireAdminModulePricing` re-verifies every sheet AND every metric by id in billing before dropping.

**Four copies of the same multiplication became one.** `PricingCalculatorService` (admin-api), `CustomPlanService.calculatePlanPricing`, `CreateTenantPage` and `CustomPlanBuilderPage` each read the sheet and computed a price in floats. The two frontend copies were the worst: `CreateTenantPage` ignored the tier multiplier entirely and rendered ITS total, not the server's, falling back to it silently whenever the API call failed; `CustomPlanBuilderPage` hardcoded 0.7 / 0.9 / 1.0 multipliers that came from no sheet at all. Both showed operators a price the server would not charge. billing now owns `quoteModuleSelection`, every step is `Decimal`, the tier discount is computed from the list price rather than recovered by dividing the discounted price back out (the float trap, and 0/0 = NaN on a zero multiplier), and each line is rounded once to the currency's own minor unit. The calculator, the seed's fifth copy of the default price table, and `admin.module_pricing`'s entity are deleted. `PricingMetricType` moved to `libs/event-contracts` as a union with its labels and quantity map; the admin-panel derives it from the generated contract and gained the two members every hand-written copy had been missing (`per_gb_transfer`, `per_workflow`).

`BillingProvisioningModuleItem`'s three money fields are exact decimal strings now: they are billing's own quote travelling back to billing, and the round trip through IEEE-754 was the one place a priced item could disagree with the quote an operator approved. That the round trip happens at all is redundancy BILLING-CRITICAL-003 removes when provisioning moves onto `CreateSubscriptionHandler`; until then it is at least lossless. The one remaining widening is `sumModuleItemsTotal`, which sums in `Decimal` and converts once into `billing.subscriptions.pricing.basePrice` — still a jsonb `number`, still in the allowlist.

**Gate:** `tests/invariants/plan-catalog-ssot.spec.ts` extends to the three new tables, adds a rule that the retired `admin.module_pricing` name may not reappear in any entity or in `MODULE_SCHEMAS`, and asserts that the tables ADR-0013 has already normalised contribute no money-in-jsonb site at all — not even a governed one. The allowlist ceiling dropped 24 → 23 as `module_pricing`'s entry disappeared, which is the ratchet working: the gate FAILED on the stale entry before it was removed.

**Implementation note — the plan catalogue (landed 2026-09-06):** the third of the four tables has moved, and with it the last duplicated Stripe identifier. `admin.plan_definitions` was a SECOND catalogue whose ids no runtime path ever resolved — `create-subscription.handler`, `change-subscription-plan.handler`, `billing-scheduler.service` and the provisioning handler all resolve `billing.plans` — carrying its own `stripeProductId` / `stripePriceIds` (a Stripe object has one owner; two writable homes means two services can mint a product for the same plan) and a four-cycle price matrix inside a `jsonb` column where no CHECK could reject a negative price or a `discountPercent` of 400.

`1802200000000-MergePlanCatalogue` folds it in. Identity is `billing.plans.name`, the catalogue's own UNIQUE business key: a definition whose name matches UPDATES the live plan, so the operator's authored copy lands on the row the runtime actually uses, and one whose name is new is INSERTed keeping its id. The price matrix expands into `billing.plan_cycle_prices` — one row per (plan, cycle), `numeric(19,4)` prices under `CHECK (>= 0)` and `discount_percent` CHECKed into [0, 100] — and `features.addOns[]`, which was money nested two levels inside a features blob, becomes `billing.plan_add_ons` rows. `1809100000000-RetireAdminPlanDefinitions` re-verifies by name that every definition, every cycle it priced and every add-on it sold has a counterpart, RAISES rather than dropping if one is missing, re-points `admin.plan_module_assignments.plan_id` and `admin.custom_plans.base_plan_id` at the surviving billing id (the merge discards a matched definition's own id), drops their FK constraints — admin does not constrain another service's table — and only then drops the table.

**Three shapes collapsed into one.** `PlanTier`, `BillingCycle` and `PlanVisibility` were declared on the deleted entity and imported by eleven admin files; `BillingCycle` in particular existed twice, as an admin TypeScript `enum` and as the contract's string union, and `tenant-provisioning-workflow.service` carried two enum-to-enum mappers whose only job was to convert between them. `BILLING_CYCLES` and `BILLING_PLAN_VISIBILITIES` are now runtime-enumerable consts beside their unions in `@platform/event-contracts`, each pinned to its union by a compile-time parity type, so a `class-validator` `@IsIn`, a TypeORM `enum:` column and the contract all read one list. Both mappers are deleted.

The write DTOs follow: `pricing` (a fixed four-cycle object of floats) became `cyclePrices: PlanCyclePriceDto[]` of exact decimal strings, `features.addOns` became a top-level `addOns` of priced rows, and `PERCENT_STRING` was tightened from "up to three digits" to the [0, 100] the columns CHECK — it had been accepting 999.99 for discount codes too. `POST /billing/plans/seed` is gone: seeding the catalogue is billing's own boot-time concern (`PlanSeedService`), and an admin route seeding a second catalogue was the finding in miniature. The admin-panel's hand-written `PlanDefinition` / `PlanPricing` / `PlanLimits` / `PlanFeatures` are replaced by the generated contract types (four of CONTRACT-CRITICAL-003's sixteen shadow types), and `PlanManagementPage` renders every cycle the plan is actually sold on, in the plan's own currency, through a shared decimal formatter — it previously read `plan.pricing.monthly.basePrice` unconditionally and formatted with a hardcoded `'USD'` and `minimumFractionDigits: 0`, which rendered a $19.99 plan as "$20".

One defect was found while writing the billing-side spec: `PlanCatalogService` re-read the plan after a write without its relations, so the snapshot returned by `createPlan` / `updatePlan` / `deprecatePlan` carried `cyclePrices: []` — indistinguishable on the wire from a plan with no prices at all. Every read of a plan now loads its priced children.

**Gate:** `tests/invariants/plan-catalog-ssot.spec.ts` extends to `plan_cycle_prices` and `plan_add_ons` and adds `plan_definitions` to the retired names that may not reappear. Both duplicated Stripe identifiers left the allowlist, so `duplicateStripeIdentifiers` is down to the two `admin.tenant_billing_info` entries that BILLING-CRITICAL-003 owns.

**Implementation note — custom plans (landed 2026-09-06):** the last of the four tables has moved, and BILLING-CRITICAL-002's table list is now empty. `admin.custom_plans` held the whole priced selection inside ONE `jsonb` column — every module's `subtotal` and every line item's `unitPrice` and `total` — where a jsonb number IS an IEEE-754 double and no CHECK can reach it, and priced it in admin with the fourth float copy of billing's own arithmetic. `1802300000000-MoveCustomPlans` creates `billing.custom_plans` + `custom_plan_modules` + `custom_plan_line_items`, keeps the plan's id (nothing outside billing resolves one), resolves `basePlanId` against the merged `billing.plans` — an id that resolves to nothing becomes NULL rather than a dangling FK — and expands the jsonb selection into rows; `1809200000000-RetireAdminCustomPlans` re-verifies every plan AND every priced module by id before dropping.

**One rule now prices a negotiated plan.** The discount was applied in three places that had to agree: `CustomPlanService.calculateFinalTotal`, the entity's own `calculateDiscount()`, and `CustomPlanBuilderPage` in the browser. The browser's copy was wrong outright — its annual figure took the fixed discount off TWELVE times where the server takes it off once, so an operator negotiating "$500/mo off" was shown a yearly price $5,500 below what billing would charge. `quoteModuleSelection` now accepts `negotiatedDiscountPercent` / `negotiatedDiscountAmount`, applies them in `Decimal` and returns the total; the builder quotes with them and renders the number it gets back, and `CustomPlanService.create/update` store that same number. There is no second implementation left to drift. `roundToCurrency`, which had two byte-identical copies inside billing-service, moved to `@aquaculture/backend-common/monetary` beside `getCurrencyScale`.

**Four defects fixed rather than carried across.** (a) `discountPercent` was an unbounded `number` on a `numeric(5,2)` column: 400 was storable, and `Math.max(0, …)` turned it into a plan priced at zero instead of an error — it is CHECKed into [0, 100] now and refused at the DTO, the service and the column. (b) Nothing in the platform ever set a plan to `expired`, and `isValid()` existed but was called from nowhere, so `getCustomPlanByTenant` returned plans whose `validTo` had passed years earlier as the tenant's current price — the window is part of the query now, and activation refuses a lapsed plan. (c) `clonePlan` spread the source row wholesale and took no actor, so a clone was credited to whoever wrote the original and carried its rejection reason and subscription id; it is credited to the operator who cloned it and starts clean. (d) `submitForApproval` recorded no actor at all. Separately, `admin.custom_plans` carried the base-plan reference in TWO columns — `"basePlanId"`, which the ORM wrote, and `base_plan_id`, which the FK was built on and nothing ever populated; the plan-catalogue drop migration re-points both, having originally re-pointed only the dead one.

**Gate:** `tests/invariants/plan-catalog-ssot.spec.ts` extends to the three new tables and adds `custom_plans` to the names that may not reappear under `schema: 'admin'`. The money-in-jsonb ceiling dropped 23 → 22 as `CustomPlanModule.subtotal` disappeared — the gate FAILED on the stale entry before it was removed, which is the ratchet working.

**Still open under this finding (owner okan, deadline 2026-12-31):** the twelve `PlanPricing` allowlist entries were RE-ATTRIBUTED from this finding to BILLING-CRITICAL-003 rather than closed: `billing.plans.pricing` is not the per-cycle matrix (that is now rows) but the flat per-unit rate card a subscription snapshots at signup, byte-identical in shape to `billing.subscriptions.pricing` and `scheduled_plan_changes.pricing`. Normalising one without all three would split the snapshot, so all three move together with the subscription money path. The allowlist ceiling is unchanged at 23 for that reason — this wave removed no money-in-jsonb site, and saying otherwise would be the audit theater the traceability rule exists to prevent.

## BILLING-CRITICAL-003 — Raw SQL against subscriptions; dead Stripe reconciliation; no idempotency (R8, C14)

**State:** OPEN · **Wave:** W4 · **ADR:** 0014 (depends on 0013)

**Fix (Tier-1):** provisioning via `CreateSubscriptionHandler` (FREE is the only non-Stripe tier). Delete the three raw-SQL blocks in favour of Cancel / Reactivate / ExtendTrial handlers. Fix the five webhook consumers to read `internalTenantId` through a shared constant (producer rename rejected — it would orphan every existing Stripe object) plus a real customer-lookup fallback. `BillingAdminCommandMeta` gains required `idempotencyKey` + `correlationId`, receipts on all eight commands. Seed `billing.plans` for every cycle.
**Gate:** `tests/invariants/billing-command-contract-ssot.spec.ts` — sender type, consumer pattern and NATS grant derived from one declaration; metadata-key symmetry; no raw write to `billing.subscriptions` outside a command handler.

## CONTRACT-CRITICAL-003 — No machine-readable FE↔BE contract; interface DTOs disarm validation (R9, C1, C2)

**State:** OPEN · **Wave:** W2 (class DTOs) / W3 (artifact) · **ADR:** 0015

**Fix (Tier-1):** all 29 interface-typed `@Body()` parameters become classes with class-validator decorators, with DB CHECK / length / `inet` constraints in the same migration set. OpenAPI is emitted from Nest DTOs via the existing `SwaggerModule.createDocument` into a committed `apps/admin-api-service/openapi.json`; `openapi-typescript` generates `src/services/generated/`; `services/types/*`, `contract-validation.spec.ts` and `KNOWN_EXCEPTIONS` are deleted. One `Paginated<T>` and the seven enums live in `libs/event-contracts`; `AuditLogInput.action` becomes `AuditAction`.
**Gates:** `tests/invariants/admin-openapi-artifact-parity.spec.ts` (byte-equality of artifact and generated client) and `admin-body-dto-is-class.spec.ts` (no `@Body()`/`@Query()` resolving to `Object`).

**Implementation note — class DTOs (landed 2026-09-05):** the hard precondition is done. The 21 remaining `interface`-typed `@Body()` parameters (of the 29; eight were converted in W2/W3 as their routes were touched) are classes with class-validator decorators, nested one level down as well: `apps/admin-api-service/src/billing/dto/billing.dto.ts` gains the twelve billing bodies plus thirteen nested value objects (plan limits, per-cycle pricing, features and add-ons, pricing metrics, tier multipliers, module quantities and selections, billing address, invoice line items and tax), `modules/dto/module-request.dto.ts` and `messaging/dto/messaging-admin.dto.ts` are new, and the three email-template bodies join `settings/dto/email-template.dto.ts`. Every nested shape is reached through `@ValidateNested` + `@Type`, so `whitelist` / `forbidNonWhitelisted` apply at every level rather than only at the envelope — a legal hold can no longer be opened with an empty reason, a retention window is bounded to 1–3650 days, and a plan tier must be a `PlanTier`. No DTO declares an actor (`createdBy` / `updatedBy` / `changedBy`): the ESLint rule `no-actor-in-input-dto` makes that a build error, so a body that claims one is now REFUSED (400) rather than silently overwritten, which is the stronger half of ADMIN-CRITICAL-008; `billing.controller.spec.ts` asserts the refusal and the JWT-sourced actor separately. Three bodies that carried a raw `tenantId` (`PlanChangeRequest`, `CreateCustomPlanDto`, `CreateInvoiceDto`, plus the two email-template bodies) now use the `@TenantIdCarrier()` + `@TenantParam('body')` form from ADMIN-CRITICAL-009. Gate: `tests/invariants/admin-body-dto-is-class.spec.ts` over `tests/invariants/lib/dto-resolution.ts` — every unkeyed `@Body()` / `@Query()` must resolve, through imports, barrels and path aliases, to a `class` carrying at least one class-validator decorator on itself or an ancestor; an unresolvable type fails rather than being assumed good. Still open under this finding: the committed `openapi.json` artifact and its Nx target, the `openapi-typescript` client for admin-panel with `services/types/*` deleted, the single `Paginated<T>` envelope, and the retirement of `contract-validation.spec.ts` with its `KNOWN_EXCEPTIONS`.

**Implementation note — the artifact (landed 2026-09-05):** `apps/admin-api-service/openapi.json` is committed and generated by `nx run admin-api-service:openapi` (`tools/openapi/generate-admin-openapi.cjs` → `src/openapi/generate-openapi.ts`). The app is created in Nest PREVIEW mode: the full module graph is built and every controller registered, but no provider is instantiated and no lifecycle hook runs, so generation touches neither Postgres, Redis nor NATS and takes about twelve seconds anywhere. The runner registers `@nestjs/swagger/plugin` as a TypeScript transformer before the module graph loads — without it a Nest DTO's shape stays in its TS types and class-validator decorators and every schema is `{}`, which is the same vacuous contract an interface DTO produced. The document now carries 401 paths and 148 schemas with real properties: `required` lists, `minLength`/`maxLength` from the validators, enum members from the enums, and `$ref`s into the nested value objects. The `DocumentBuilder` configuration moved to `libs/backend-common/src/bootstrap/openapi-config.ts` so the served document and the artifact are built by one function, and `@TenantIdCarrier()` now also describes itself to OpenAPI as an optional uuid string — the wire contract carries the key even though the handler's type for it is `undefined`. Gate: `tests/invariants/admin-openapi-artifact-parity.spec.ts` regenerates and asserts byte-equality with the committed file, that every controller route appears in it, and that NO schema is empty — the last is what stops a silently dropped transformer from making a vacuous artifact agree with itself. The artifact is in `.prettierignore` because reformatting it would break that equality. Debt, tracked under this finding (owner okan, deadline 2026-12-31): the runtime build is plain `tsc`, which cannot apply the transformer, so the dev-only `/docs` UI shows the same routes with thinner schemas than the artifact; closing it means adding the plugin to `tools/build/build-service.sh` for every service. Still open: the `openapi-typescript` client for admin-panel with `services/types/*` deleted, the single `Paginated<T>` envelope, and retiring `contract-validation.spec.ts` with its `KNOWN_EXCEPTIONS`.

**Implementation note — the generated client (landed 2026-09-05):** `web/modules/admin-panel/src/services/generated/admin-api.ts` is produced from the artifact by `openapi-typescript` (`nx run admin-panel:openapi-client`), and the parity gate now asserts that link too: a client regenerated from a stale artifact fails the same spec. Responses are typed as well as requests — moving the 56 DTO classes that were declared inside `*.controller.ts` files into sibling `dto/*.dto.ts` files was the precondition, because the `@nestjs/swagger` plugin visits a file EITHER as a controller (typing responses) or as a model (typing DTOs), never as both, so a DTO beside its routes cost that whole controller's response schemas. The artifact now carries 334 typed responses and 185 schemas, none empty. Consumption has started where it proves the most: `services/contract.ts` exposes `ApiSchema<'Name'>`, and eleven hand-written request types in `services/types/*` are now aliases of it. The compiler immediately found five real drifts that had been invisible, and each is fixed rather than cast away: the custom-plan builder and the discount page were sending a hardcoded `createdBy: 'admin'` (a fabricated actor the server now REFUSES, ADMIN-CRITICAL-008); the tenant-create form's tier union contained `custom`, which `POST /tenants` does not accept, so that path could only ever have 400'd; the tenant-detail edit form prefilled a `custom` tier into an update body that rejects it, and now leaves it unset behind an `isEditableTenantTier` guard; and two TypeScript `enum`s (`DiscountType`, `TenantProvisioningState`) were nominal, so their members were not assignable to the strings the API actually exchanges — both are now unions derived from the contract with a const object preserving every call site. Still open under this finding (owner okan, deadline 2026-12-31): the remaining sixteen hand-written types in `services/types/*` that shadow a generated schema (entities like `Tenant`, `SupportTicket`, `FeatureToggle`) are not yet aliased — each has a wide page-level blast radius and is its own change; the single `Paginated<T>` envelope; and retiring `contract-validation.spec.ts` with its `KNOWN_EXCEPTIONS`, which stays until those pages are migrated so the URL-shape check is not lost in the meantime.

## ADMIN-CRITICAL-008 — Actor from client strings; 273 mutations unaudited; audit writer swallows (C8)

**State:** OPEN · **Wave:** W2

**Fix:** actor is never a DTO property (banned property names enforced structurally) and comes from `@CurrentUser` only; the awaited transaction-aware `AuditedOperationInterceptor` is adopted across admin-api; `audit.service.log` becomes `logOrThrow` by default; the audit-forgery endpoint is deleted.
**Gate:** `tests/invariants/admin-mutation-audit-coverage.spec.ts` (reflected metadata, ratcheting allowlist); admin-api added to `SERVICES_REQUIRED` in `audited-operation-module-wired.spec.ts`.

## ADMIN-CRITICAL-009 — tenantId is a transport value; erasure is structurally impossible (C9)

**State:** OPEN · **Wave:** W3

**Fix:** `@TenantParam()` resolves the id to a verified ACTIVE `auth.tenants` row before any handler runs. Erasure targets become an explicit per-table registry (`tenant-column | cascade-via | excluded-with-reason`).
**Gate:** every table in `MODULE_SCHEMAS[].tables` is classified in the erasure registry; e2e erases a tenant holding support threads, invoices and audit rows.

**Implementation note (landed 2026-09-05):** `@TenantParam(source, { key?, optional?, allow? })` (kernel `decorators/`) attaches `VerifiedTenantPipe` (kernel `tenant/`), which resolves the id through the `TENANT_ACTIVE_CHECK` port bound by admin-api's global `TenantLookupModule` (read-only `auth.tenants`, D14): missing → 400 unless optional, non-UUID → 400, unknown → 404, and a lifecycle check — a mutation admits ACTIVE only unless the route states `allow` (lifecycle, provisioning, billing and schema routes say `'any'`), a read admits every existing tenant. 115 `@Param('tenantId')` / `@Query('tenantId')` sites, the tenant controller's 15 `:id` routes and 23 body DTOs (`tenantId` removed from the class, taken by `@TenantParam('body')` on the handler) were converted; the ESLint rule `no-unverified-tenant-param` (admin scope, error) and `tests/invariants/admin-tenant-param-verified.spec.ts` keep the raw forms out. Erasure: `libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-table-policy.ts` — every source-schema target declares `tenant-column | cascade-via | excluded(reason)` for every registered table; the executor refuses to construct on an incomplete set, confirms every named column against `information_schema` before deleting, orders cascade children before parents without relying on a database FK, and derives nothing from column names; `tests/invariants/tenant-erasure-table-policy.spec.ts` checks completeness and that every named column is declared in source. Not done here: bulk `tenantIds[]` bodies (bulk suspend/activate, broadcast targets) still pass arrays the pipe does not resolve (owner okan, W3, this finding); the live e2e that erases a tenant holding support threads, invoices and audit rows needs the running platform and is not written in this session — the kernel cascade spec (`tenant-erasure-target-executor.cascade.spec.ts`) covers the same paths against a fake database.

## ADMIN-CRITICAL-015 — Email template preview iframe has no sandbox (SA-008)

**State:** OPEN · **Wave:** W0

`EmailTemplatesPage.tsx:317` renders operator-editable HTML via `srcDoc` with no `sandbox`, a same-origin path to the SUPER_ADMIN token.
**Fix:** one `SandboxedPreview` component in shared-ui that structurally sets the sandbox and is the only permitted way to render untrusted HTML; ESLint rule banning raw `srcDoc` / `dangerouslySetInnerHTML` under `web/**`.
**Gate:** the lint rule plus a component test asserting the sandbox attribute cannot be omitted.

## ADMIN-HIGH-010 — No shared admin-panel query/mutation primitive; page-local pagination and stats (C3, C17)

**State:** OPEN · **Wave:** W6

**Fix:** migrate every page onto the existing `useAdminQuery` / `useAdminMutation` / `adminQueryKeys`; delete `useAsyncData`. One `AdminTable` contract owns server-side pagination, sort, search and dataset-scoped aggregates; materialised tenant-resource rollups and the missing indexes back it.
**Gate:** ESLint bans `useState`+`useEffect` fetching and bare `apiFetch` under `pages/**`; AST rule bans aggregates computed from a fetched array; `no-console: error` re-enabled with a shrinking allowlist; bundlesize budget.

## ADMIN-HIGH-011 — Retired stores left as 410/409/501 stubs; route shadowing (C4, C5)

**State:** OPEN · **Wave:** W3

**Fix:** retirement deletes route and client in the same commit as the store; a route-registration linter orders static segments before parameterised ones.
**Gate:** no controller method body reduces to a thrown Gone / Conflict / NotImplemented; smoke gate that every FE-called route returns something other than 404/410/501 on a booted app.

**Implementation note (landed 2026-09-05):** every route that existed only to refuse is deleted with its service method, DTO, frontend client and page control in one commit: the whole tenant-configuration stack (controller, service, DTOs, entity file, the provisioning saga's fake `create_default_config` step, the admin-panel page, route and client — 40 routes that synthesised defaults on read and answered 410 on write); the nine system-settings write routes and the `SystemSettingService` writers behind them; the global-config CRUD routes, `PUT provisioning-config` and the `ConfigCategory`/`ConfigValueType` vocabulary (the env-backed `GET provisioning-config` stays: sensor-service's installer-script generator reads it); the three messaging 501 routes with the Monitoring and AI Dashboard pages, the persona toggle and the "not yet available" tenant-overview card; `GET tenants/approaching-limits` (501) with its query, handler and client; the 409 refusals — `POST billing/subscriptions`, `process-renewals`, `invoices/update-overdue`, four schema routes (create, suspend, activate, refresh-stats), three migration routes (run, rollback, batch run) — with the fourteen `never`-typed service methods behind them, the unreferenced `SchemaMigrationService`, the provisioning saga's `create_schema` step that could only throw, and every frontend button that called them. Custom-plan activation, which called the retired `createSubscription` writer and therefore could never activate a plan, now sends billing-service's `ProvisionTenantSubscription` command with the plan's priced modules and the plan discount allocated across them; both command identifiers derive from the plan id so a retry replays billing's receipt (`custom-plan.activation.spec.ts`). Two literal routes shadowed by `data-requests/:id` (`stats`) were reordered. Gates: `tests/invariants/admin-no-stub-routes.spec.ts` (no `NotImplementedException` in admin-api; `GoneException` only in the allowlisted report-download expiry; no route handler whose body reduces to a throw, a `throw*` helper call, or a `never` type) and `tests/invariants/admin-route-registration-order.spec.ts` (a parameterised route declared before a literal sibling it would match fails, within a controller and across controllers sharing a prefix), both over `tests/invariants/lib/admin-route-table.ts` (TypeScript-AST route enumeration). The FE↔BE contract test's `matchPath` no longer treats a frontend literal as matching a backend parameter, so a client for `/jobs/scheduled` can no longer pass against `/jobs/:id`; the two clients that did were deleted. The "booted app" smoke gate is not written as a runtime test: the three static gates together make a 404 (contract), 410/501 (no-stub) or shadowed (order) FE route a build failure, which is the property the smoke gate was to prove.

## ADMIN-HIGH-012 — Permissive physical types in the admin schema (C11)

**State:** OPEN · **Wave:** W2

**Fix:** one forward migration per class (timestamptz, uuid tenantId, numeric money, real arrays, inet) landed together with `{ type: 'timestamptz' }` on every decorator; `SCHEMA_DRIFT_FATAL` in production.
**Gate:** no admin column is `timestamp without time zone`; decorator lint bans bare `@CreateDateColumn()` / `@UpdateDateColumn()`; CHECK presence invariant on money / enum / state columns.

## ADMIN-HIGH-013 — Crons without leader election, heartbeat or lease (C12)

**State:** OPEN · **Wave:** W3

**Fix:** `@LeaderOnly()` / `pg_try_advisory_lock` primitive in backend-common placed beside `CronHeartbeatService` so adopting one forces the other; job claiming via `FOR UPDATE SKIP LOCKED`; shared batched-delete helper.
**Gate:** every `@Cron` / `@Interval` in the fleet is leader-wrapped and heartbeated; `CronJobNeverRan` / `CronJobFailingEveryRun` rules are the runtime half.

**Implementation note (landed 2026-09-05):** the primitive is one decorator, `@ScheduledJob({ name, cron | every, scope? })` (`libs/backend-common/src/scheduling/`), which applies the NestJS schedule decorator itself and wraps the tick in `ScheduledJobRunner.run`: a Postgres transaction-scoped advisory lock keyed on (service, job) — `pg_try_advisory_xact_lock(hashtext(service), hashtext(job))`, released with the transaction and therefore with a crashed replica's connection — and `CronHeartbeatService.track` for the tick that wins; a losing replica records `outcome="skipped"`. The decorator is typed against `HasScheduledJobRunner`, so a class without a `scheduledJobs` runner does not compile, and every job name is declared at boot so `CronJobNeverRan` has a series to alert on. `scope: 'each-replica'` is for per-process housekeeping (the error-tracking cooldown map) and skips the lock, never the heartbeat. All 21 admin-api scheduled methods (13 classes) are converted; `ScheduledJobModule.forRoot({ serviceName: 'admin-api-service' })` is registered. Job claiming in `JobQueueService` is one transaction — `SELECT … FOR UPDATE SKIP LOCKED`, dependency check, the RUNNING transition — so two replicas or two overlapping ticks cannot execute the same row (`job-queue.claim.spec.ts`). The single retention authority now disposes in ctid-addressed batches through the shared `deleteInBatches` helper (`libs/backend-common/src/database/batched-delete.ts`). Gate: `tests/invariants/scheduled-jobs-leased.spec.ts` over `tests/invariants/lib/scheduled-method-table.ts` (TypeScript-AST enumeration of every `@Cron`/`@Interval`/`@Timeout`/`@ScheduledJob` in apps, libs and platform libs): a raw decorator fails unless it is a governed entry in `.claude/allowlists/unleased-scheduled-jobs.yaml` (owner, expiry 2026-12-31, ADMIN-HIGH-013, ceiling that only decreases, entries that must still exist); admin-api may have no entries; job names must be literal, well-formed and unique per service; every service declaring a `@ScheduledJob` registers the module; `CronHeartbeatService` is reached only through the runner. The three existing cron invariants now count `@ScheduledJob` as a scheduler entry point. The runtime half (`CronJobNeverRan`, `CronJobFailingEveryRun` in `infrastructure/monitoring/droplet/rules/60-dataflow-integrity.yml`) already exists and now covers every admin job by construction. Not done here: the 67 raw scheduler sites in the other eight services and the two platform libs are frozen in the ratchet with owner okan and expiry 2026-12-31 under this finding; each converts by adding the runner and swapping the decorator, and the ratchet fails when one is converted without its entry being removed.

## ADMIN-HIGH-014 — Detective stores with no producer (C16)

**State:** OPEN · **Wave:** W5

**Fix per store:** outbox-backed projection from auth-service login/session events, or delete the store with its detector and dashboard. No middle state.
**Gate:** every entity registered in `MODULE_SCHEMAS[].tables` has at least one write reference in its owning service.

## OBS-CRITICAL-003 — The admin observability path does not exist (C13)

**State:** OPEN · **Wave:** W5

**Fix (ordered):** mask the message path (OBS-CRITICAL-004) → ship logs → OTLP tracing → admin-api SLO rules on existing RED metrics → in-app health surfaces return `{status: 'ok' | 'unavailable'}` → delete fabricated dashboards only after Grafana replacements exist.
**Gate:** every scraped service scrapeable; every alert metric registered; every `runbook_url` resolves to `docs/runbooks/`.

## OBS-CRITICAL-004 — StructuredLoggerService emits the message argument unmasked (SA-054)

**State:** OPEN · **Wave:** W0

`structured-logger.service.ts:72-86` masks context values; `:133-146` passes the message through verbatim.
**Fix:** the message goes through the same `maskPii` boundary in `writeLog`; unit test proves a PII-bearing message is masked on every level. Must precede any log shipping.

## PLAT-CRITICAL-902 — BeginProvisioning is missing from the admin-api NATS publish grant (SA-032)

**State:** OPEN · **Wave:** W0

`services.yaml:317-327` lacks `request.auth.tenant.BeginProvisioning`; every tenant creation 502s after the 15 s request timeout.
**Fix:** add the grant and regenerate `nats.conf` in one commit; extend the provisioning SSoT invariant so every subject a service publishes (derived from the command contract) must appear in that service's publish ACL.

## CLAUDE-LOW-016 — CLAUDE.md "Migration Runners" matches no service (ARCH-LOW-012, C7)

**State:** OPEN · **Wave:** W7

**Fix:** shrink the Tier-4 text to a pointer at `libs/backend-common/src/database/typeorm-config.factory.ts` + `apps/db-migrate`; extend `claude-md-accuracy.spec.ts` to resolve `<svc>` against the real service list.

## 3. Execution order (dependency topology)

| wave                                      | content                                                                                                                                             | edge                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W0 — make measurement trustworthy**     | INFRA-HIGH-141 (lift stale test quarantine, governed policy); OBS-CRITICAL-004; INFRA-HIGH-142; ADMIN-CRITICAL-015; SEC-HIGH-061; PLAT-CRITICAL-902 | a gate on a quarantined project never runs; tenant creation must work before anything downstream is testable; two live pre-auth paths are independent of all other work |
| **W1 — recoverability + topology**        | INFRA-CRITICAL-140 (backups); DATA-CRITICAL-013 (retention); SEC-CRITICAL-056 (edge bundle)                                                         | nothing may drop a table while no restore path exists; AccessLog on admin-api needs working retention                                                                   |
| **W2 — write boundary + authority**       | class DTOs (CONTRACT-CRITICAL-003 precondition) + ADMIN-HIGH-012 migrations; SEC-CRITICAL-057; DATA-CRITICAL-012; ADMIN-CRITICAL-008                | class DTOs re-arm ValidationPipe fleet-wide in one change; audit must fail closed before the destructive ledger is a control                                            |
| **W3 — contract, authz, execution model** | CONTRACT-CRITICAL-003 artifact; SEC-CRITICAL-058; SEC-HIGH-059; SEC-HIGH-060; ADMIN-CRITICAL-009; ADMIN-HIGH-011; ADMIN-HIGH-013                    | generation precedes FE cleanup; MFA and capabilities mount on the single act-as authority                                                                               |
| **W4 — money**                            | BILLING-CRITICAL-002 then BILLING-CRITICAL-003                                                                                                      | `CreateSubscriptionHandler` resolves `billing.plans`; receipts before catalogue migration                                                                               |
| **W5 — detective stores + observability** | ADMIN-HIGH-014; OBS-CRITICAL-003                                                                                                                    | honest replacement before deleting the dishonest window                                                                                                                 |
| **W6 — FE architecture**                  | ADMIN-HIGH-010                                                                                                                                      | consumes the generated contract                                                                                                                                         |
| **W7 — kill list + docs**                 | §4; CLAUDE-LOW-016                                                                                                                                  | dead set is machine-derived after W3                                                                                                                                    |
| **W8 — read path**                        | materialised rollups, parallel capped health fan-out, indexes, per-request connection scope                                                         | index after the type conversions                                                                                                                                        |

Critical path: `INFRA-HIGH-141 → DATA-CRITICAL-013 → SEC-CRITICAL-056 → SEC-CRITICAL-057 → {SEC-CRITICAL-058, SEC-HIGH-059}` and `INFRA-HIGH-141 → CONTRACT-CRITICAL-003 → BILLING-CRITICAL-002 → BILLING-CRITICAL-003`, with INFRA-CRITICAL-140 gating the destructive half of every wave.

## 4. Kill list

**Delete by ruling:** impersonation module + 3 tables + page + debug-tools sub-module (0007); `ip_access_rules` + page + gateway `IpWhitelistGuard` (0010); admin backup subsystem + `schema_backups` / `schema_restores` (0009); `retention_policies` + runtime CRUD + page + 8 ad-hoc crons (0012); `admin.plan_definitions` / `module_pricing` / `custom_plans` / `discount_codes` migrated to billing (0013); dead CSRF middleware platform-wide (0006); `security.mfa_enabled` key + `mfaCompleted` (0011); `services/types/*` + `contract-validation.spec.ts` + `KNOWN_EXCEPTIONS` (0015).

**Delete outright (no consumer verified):** DebugToolsPage + `debugApi` + 5 debug tables (archive encrypted or discard — they hold raw tenant SQL, bodies and `Set-Cookie` headers); PerformanceDashboardPage + `performance_metrics` / `performance_snapshots` + snapshot cron; FeatureTogglesPage + `feature_toggles`; backup/restore/PITR UI + routes; migration run/rollback/batch panel; `QueryEditor.tsx` + explorer SQL executor + explorer row CRUD; `AdminLayout.tsx`, `admin-nav-items.tsx`, `TenantSelect` / `TenantMultiSelect` / `useTenants`, `useMessaging`, `useAnnouncements`, admin-panel `graphql/messaging-operations.ts`; 118 dead client functions; `settings.controller.ts` write half; schema create/suspend/activate routes (fold into the tenant saga); cache flush; versions deploy/rollback + `system_versions`; `GET /maintenance/check?isSuperAdmin=`; `logSlowQuery` / `recordRequestMetric` / `aggregateRequestMetrics`; `createOrUpdateBillingInfo` + `tenant_billing_info`; in-memory alert-rule CRUD; `loki-values.yaml`; login-success-ratio SLO rule; 15 `wiki.internal` runbook URLs; `impersonation_sessions.originalSessionToken`; shadow FK columns `custom_plans.base_plan_id` / `plan_module_assignments.plan_id`; `shared.user_permissions` resurrection in the Baseline.

**Delete with a coupled decision:** TenantConfigurationPage, ProvisioningSettingsPage, MessagingMonitoring / AiDashboard / AiPersonas pages (delete the route first); ErrorTrackingPage (delete unless a reporter is wired); `useAsyncData` (after W6); `login_attempts` / `user_sessions` / `api_usage_logs` + detectors (ADMIN-HIGH-014); `slow_query_logs` / `database_metrics` (with the `pg_stat_statements` decision); `maintenance_modes` (if maintenance moves to the gateway); `password-reset.controller.ts` (second un-rate-limited pre-auth ingress); `tenants.ts deactivate/archive` (adopt with `@Destructive` or delete both sides); 168 dead backend routes as a set after W3; K8s alert rule files (port useful rules to `droplet/rules` first); Grafana dashboards (rebuild).

**Keep behind break-glass:** explorer export (`explorer.controller.ts:543-647`) — needs a justification field, formula-prefix escaping and a default ORDER BY. `/database/schemas/sync` moves to a CLI runbook.

## 5. Page status matrix (summary)

| status         | pages                                                                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEGRADED (FIX) | TenantManagement, TenantDetail, Modules, AnalyticsDashboard, Tickets, Messaging inbox, BillingDashboard, Invoices, Payments, CustomPlanBuilder, ModulePricing, UsageDashboard, BillingReports, ActivityLog, SystemSettings                                                                                     |
| BROKEN         | CreateTenant (NATS ACL), UserManagement, Onboarding, DatabaseManagement, DatabaseExplorer, EmailTemplates, SubscriptionManagement, DiscountCode, CustomPlansList, MessagingAiPersonas, MessagingRetention, MessagingAudit, AuditLog, Maintenance, JobQueue, ErrorTracking                                      |
| FAKE           | AdminDashboard, TenantConfiguration, Impersonation, Reports, Announcements, IpAccessRules, ProvisioningSettings, PlanManagement, MessagingMonitoring, MessagingAiDashboard, MessagingCompliance, MessagingTenants, SecurityDashboard, AuditTrail, Compliance, FeatureToggles, PerformanceDashboard, DebugTools |

The full per-page evidence (finding IDs per page, verdicts, per-agent reports) lives in the session artefacts and is summarised by the umbrella findings above.

## 6. Corrections to earlier phases (verified)

- `adminRoutes.ts` is LIVE (imported by AdminDashboard and AnalyticsDashboardPage) — not deletable.
- Per-tenant migration run/rollback and the explorer raw query are UNREACHABLE (unconditional throw / `NODE_ENV`), which strengthens the deletion case.
- Explorer `ALLOWED_SCHEMAS` excludes `tenant_*`; the composite-PK defect is real within the four allowed schemas; `auth.users` and `auth.tenants` remain fully readable and exportable.
- Deactivating a user DOES revoke sessions on both admin paths; the defects are labelling and attribution.
- Retention exists for several tables Phase 1b listed as unbounded, but as ad-hoc crons outside the registry with no legal hold — a third engine, not compliance.
- `docs/adr/018-protected-tables-ssot.md` cited by `protected-tables.ts:64` does not exist.

## 7. Human decisions required

1. **SEC-CRITICAL-058 cutover:** enrolment date and break-glass procedure for a locked-out operator.
2. **Ownership reassignments** (prompt-writer task): data-expert ← retention lib; billing-expert ← catalogue tables (admin-expert secondary); platform-kernel-expert ← edge bundle; auth-security-expert ← promoted effective-tenant middleware.
3. **Quarantine owners and expiries:** every remaining `knownUnstableProjects` entry now names an owner and an expiry; the fleet-wide lint entries were assigned to the repository owner with a 2026-12-31 expiry and INFRA-HIGH-141 as their finding.

## 8. Not audited

notification-service, tenant-admin twin pages, shell `ROLE_HIERARCHY`, accessibility, i18n, load under traffic, the 32nd top-level page (unnamed in the corpus). The aquamobil copy of `messaging-operations.ts` is out of scope for this review.
