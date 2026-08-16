# AquaMobil access boundary audit — 2026-08-16

**Agent:** `access-boundary-auditor` · **Mode:** CATCHER (read-only) · **Lane:** mobile
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** BLOCK
**Findings surviving verification:** 12 (CRITICAL 0 · HIGH 1 · MEDIUM 9 · LOW 2)

> Produced by a 27-agent audit workflow, then verified by a second 25-agent pass.
> **Every** claim — CRITICAL through LOW — was handed to an independent verifier
> instructed to **refute** it by reopening each cited line, with "refuted" as the
> default when the evidence did not clearly hold. Claims that could not be defended
> were dropped into the Refuted section below; claims that proved smaller or larger
> than filed carry a corrected severity.
>
> **Finding IDs** use the `PRODUCT-ACCESS-*` prefix this agent's contract in
> `.claude/shared/output-format.md` assigns it. That prefix is **rejected** by the
> `id` pattern in `docs/reviews/_registry/findings.jsonl.schema.json`, so these findings
> cannot be registered at all — see `PROC-MEDIUM-016` in the cycle report.

## Scope

Read the aquamobil access surface end-to-end: `web/apps/aquamobil/src/App.tsx` (route table \+
ProtectedRoute \+ FeatureRoute), `components/MultiFeatureRoute.tsx`,
`components/IdentityBoundary.tsx`, `components/cards/TankCard.tsx`,
,
,
,
`graphql/operations.ts`, `layouts/MobileLayout.tsx`, `pages/operations/*`,
(global guard chain), `common/authz/permission-matrix.ts`, `mobile-dashboard/{resolver,handlers}`,
`farm-stock/farm-stock.resolver.ts`, `batch/resolvers/batch.resolver.ts`,
`feeding-protocol/resolvers/meal-execution.resolver.ts`,
,
,
`storage/storage.resolver.ts`, `task/resolvers/task.resolver.ts`,
`harvest/resolvers/harvest.resolver.ts`;
;
`apps/alert-engine/src/alert/resolvers/alert.resolver.ts`;
,
`modules/authentication/services/token.service.ts`;
`libs/backend-common/src/guards/{roles.guard.ts,mobile-feature.guard.ts}`;
.
Prior cycle report `docs/product-audits/access-boundary-auditor/2026-04-13-full-platform-e2e.md` was
read for repeat-defect escalation.

```text
components/hub/QuickActionGrid.tsx`, `hooks/useAuth.tsx`, `hooks/useMobilePermissions.ts
```

```text
hooks/useWebAuthn.ts`, `hooks/useTanks.ts`, `hooks/useLeave.ts`, `utils/feature-access.ts
```

```text
services/authenticated-fetch.ts`, `pwa/operation-registry.ts`, `pwa/sw-replay.ts
```

```text
pages/storage/StorageHubPage.tsx`. Backend counterparts: `apps/farm-service/src/app.module.ts
```

```text
feeding/resolvers/feeding-program.resolver.ts`, `fish-health/resolvers/field-capture.resolver.ts
```

```text
regulatory/regulatory-report-draft.resolver.ts`, `water-quality/water-quality.resolver.ts
```

```text
apps/hr-service/src/{attendance/attendance.resolver.ts,leave/leave.resolver.ts,app.module.ts}
```

```text
apps/auth-service/src/modules/tenant/{resolvers/mobile-settings.resolver.ts,services/mobile-settings.service.ts,services/user-lifecycle.service.ts,services/tenant-user-management.service.ts,entities/mobile-user-settings.entity.ts,dto/mobile-settings.dto.ts}
```

```text
web/modules/tenant-admin/src/components/settings/MobileSettings.tsx` \+ `hooks/useTenantData.ts
```

## Executive summary

The mobile access model has two enforcement layers that are individually sound but not bound
together. Role gating is strong: farm-service runs a global RolesGuard plus a fail-closed
PermissionMatrixGuard, and the aquamobil client mirrors the server @Roles matrix through the
`feature-access` SSoT (harvest/reports MODULE_MANAGER floors match). The per-user mobile
write-provisions an all-16-features-true, `isMobileEnabled: true` row for any user lacking one — and
it is called on every access-token mint, so a PANEL_ONLY account (explicitly denied mobile, never
provisioned) silently receives a full mobile entitlement claim at first login. `accessType` itself
is enforced at zero server layers; the biometric `loginWithToken` path does not even fetch it — a
repeat of the 2026-04-13 HIGH-001 Path 2. `@RequiresMobileFeature` is opt-in per resolver with no
invariant, so the live feeding write path (`recordMealFeeding`), all regulatory field capture,
attendance, leave-create and reports are entitlement-gated in the UI only. The tenant-admin editor
exposes 6 of 16 flags. Mobile reads (`farmStockInventory`, `stockEventsSummary`) are tenant-wide
while writes are site-scoped.

```text
*entitlement*` layer is where the boundary breaks. `MobileSettingsService.getByUserId
```

## Findings (by severity)

### HIGH

### PRODUCT-ACCESS-HIGH-003

**Title:** Feeding entitlement enforcement was lost in the v2 meal cutover — the live mobile write
path `recordMealFeeding`/`skipMeal` carries no `@RequiresMobileFeature`

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-HIGH-001` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/feeding-protocol/resolvers/meal-execution.resolver.ts:192 \-
  — no
  `@RequiresMobileFeature('feeding')`

  ```text
  @Roles(TENANT_ADMIN, MODULE_MANAGER, MODULE_USER)` then `@Mutation` `recordMealFeeding
  ```

- apps/farm-service/src/feeding-protocol/resolvers/meal-execution.resolver.ts:230 \- same for
  `skipMeal`
- apps/farm-service/src/feeding-protocol/resolvers/meal-execution.resolver.ts:58 \-
  `@UseGuards(GqlAuthGuard)` only; `MobileFeatureGuard` is not on this resolver at all
- apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts:1075 \- the LEGACY
  `recordDailyFeeding` DOES carry `@RequiresMobileFeature('feeding')`, proving the intent
- web/apps/aquamobil/src/pwa/operation-registry.ts:75 \- the mobile offline queue replays
  `recordMealFeeding` as the current feeding write ('Faz 6 öğün cutover')

**Rule violated:**

ADR-008 guard defense-in-depth; SEC-HIGH-052 mobile-entitlement contract (server-side enforcement of
`auth.mobile_user_settings.allowedFeatures`)

**Proposed fix direction:**

Do not chase the missing decorator — remove the possibility of omitting it. Bind the mobile-feature
key to the operation in the same fail-closed registry that already classifies every farm-service
operation (`permission-matrix.ts` \+ `PermissionMatrixGuard`), so a mutation reachable from the
mobile operation registry with no declared feature key is a startup/CI failure rather than an open
path. Register the entitlement guard globally (as `RolesGuard` already is) so per-resolver opt-in
cannot regress it.

**Affected surface (ripple set):**

- `apps/farm-service/src/feeding-protocol/resolvers/meal-execution.resolver.ts`
- `apps/farm-service/src/feeding-protocol/feeding-protocol.module.ts`
- `apps/farm-service/src/common/authz/permission-matrix.ts`
- `apps/farm-service/src/app.module.ts`
- `web/apps/aquamobil/src/pwa/operation-registry.ts`

**Expected closer:**

farm-domain expert WRITER mode (with auth-security-expert review)

**Verifier note:**

Fully verified. meal-execution.resolver.ts:58 class decorator is `@UseGuards(GqlAuthGuard)` only (no
MobileFeatureGuard, and the feeding-protocol module does not provide it — grep for
MobileFeatureGuard lists water-quality, feeding, harvest, task, storage, batch, leave modules only);
recordMealFeeding (:192) and skipMeal (:230) carry `@Roles(...)` with no
`@RequiresMobileFeature('feeding')`, while the legacy recordDailyFeeding
(feeding-program.resolver.ts:1075, class guarded at :300 with MobileFeatureGuard) does carry it;
operation-registry.ts:75 confirms the mobile queue replays recordMealFeeding as the current write
('Faz 6 öğün cutover'). Mitigations exist but do not cover the entitlement dimension: @Roles \+
global RolesGuard, PermissionMatrixGuard (permission-matrix.ts:73 lists recordMealFeeding,
role-based only), and fail-closed site scoping inside meal-execution.service. Net: an admin who
disables the `feeding` flag has no server-side enforcement on the live path — the same class of
defect the repo already tracked at HIGH (SEC-HIGH-052).

### MEDIUM

### PRODUCT-ACCESS-MEDIUM-001

**Title:** Mobile entitlement row is auto-provisioned all-features-true on the token-mint read path,
silently granting mobile access to accounts explicitly denied it

**Severity:** MEDIUM (filed as CRITICAL, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-CRITICAL-001` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/auth-service/src/modules/tenant/services/mobile-settings.service.ts:23 \-
  — a READ that WRITES a permissive row

  ```text
  if (!settings) { settings = this.repo.create({ userId, tenantId, allowedFeatures: { ...DEFAULT_MOBILE_FEATURES }, isMobileEnabled: true }); settings = await this.repo.save(settings); }
  ```

- apps/auth-service/src/modules/authentication/services/token.service.ts:561 \-
  inside
  `getUserMobileFeatures`, invoked on EVERY access-token mint for every tenant user

  ```text
  const settings = await this.mobileSettingsService.getByUserId(user.id, user.tenantId);
  ```

- apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:252 \-
  —
  PANEL_ONLY users are deliberately created WITHOUT a mobile_user_settings row

  ```text
  if (userAccessType === AccessType.MOBILE_ONLY || userAccessType === AccessType.BOTH)
  ```

- apps/auth-service/src/modules/tenant/entities/mobile-user-settings.entity.ts:99 \-
  `DEFAULT_MOBILE_FEATURES` sets all 16 flags to `true`
- apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts:263 \- the
  BOTH→PANEL_ONLY deactivation only mutates an EXISTING row and swallows failure with `logger.warn`

**Rule violated:**

CLAUDE.md Security — fail-closed authorization; ADR-008 guard defense-in-depth; layer-2-patterns.md
'Trust anchor' (entitlement claims must derive from an explicit grant, never from a default)

**Proposed fix direction:**

Make the absence of a grant structurally unrepresentable as an allow. Split the read path from the
provisioning path: `getByUserId` must return a deny-all projection when no row exists and never
write; provisioning becomes an explicit admin/lifecycle command keyed on `accessType`.
, not the
fallback for an unprovisioned one — introduce a separate all-false `DENIED_MOBILE_FEATURES` constant
that the token minter uses. Add a CI invariant asserting that no code path can emit a non-empty
`mobileFeatures` claim for a user whose `accessType` excludes mobile.

```text
DEFAULT_MOBILE_FEATURES` must be the `*seed` for an explicitly provisioned mobile `user*
```

**Affected surface (ripple set):**

- `apps/auth-service/src/modules/tenant/services/mobile-settings.service.ts`
- `apps/auth-service/src/modules/authentication/services/token.service.ts`
- `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts`

  ```text
  apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts
  ```

- `apps/auth-service/src/modules/tenant/entities/mobile-user-settings.entity.ts`
- `tests/invariants/ (new mobile-entitlement-fail-closed spec)`

**Expected closer:**

auth-security-expert WRITER mode

**Verifier note:**

Mechanics verified: mobile-settings.service.ts:19-31 is a read that INSERTs (`repo.save`) a row with
, and
token.service.ts:561 calls it on every access-token mint (getUserMobileFeatures).
user-lifecycle.service.ts:252 does skip provisioning for PANEL_ONLY. BUT the severity is inflated:
(a) accounts EXPLICITLY denied are honored — tenant-user-management.service.ts:263-267 sets
`isMobileEnabled=false` on the existing row and getByUserId never recreates/overwrites an existing
row, and the admin toggle path (update(), :77-100) likewise persists false; the only affected
population is users CREATED as PANEL_ONLY who have never had a row; (b) all-true is the documented,
deliberate product default (entity comment: 'All core operational features enabled by default for
new users. Tenant admin can restrict per-user'), i.e. the read path materializes the same defaults
user-lifecycle writes; (c) the claim grants no authority beyond the user's role — the only consumer
of the row is the `mobileFeatures` JWT claim, and MobileFeatureGuard sits behind RolesGuard (global
APP_GUARD, farm app.module:535) and the fail-closed PermissionMatrixGuard (:560); (d) the mobile app
itself blocks PANEL_ONLY on the password-login path (useAuth.tsx:279) and
useMobilePermissions.ts:262. Real defect (a read path should not mint an entitlement), but it is a
defense-in-depth/design gap, not a CRITICAL fail-open.

```text
{...DEFAULT_MOBILE_FEATURES}` (all 16 true, entity :99-116) and `isMobileEnabled: true
```

### PRODUCT-ACCESS-MEDIUM-002

**Title:** `accessType` (PANEL_ONLY / MOBILE_ONLY) is enforced at zero server layers; the biometric
login path does not even fetch the claim — repeat of 2026-04-13 HIGH-001 Path 2

**Severity:** MEDIUM (filed as CRITICAL, downgraded by adversarial verification)
**Layer:** 3
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-CRITICAL-002` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useAuth.tsx:383 \- `loginWithToken` sets `isAuthenticated: true`
  after only `checkMobileEnabled`; it never checks `accessType === 'PANEL_ONLY'` and never stores

  ```text
  accessType` on the user object, so the downstream `ProtectedRoute` check reads `undefined
  ```

- web/apps/aquamobil/src/hooks/useWebAuthn.ts:82 \- `VERIFY_LOGIN_MUTATION` user selection is
  `{ id email firstName lastName role tenantId }` — `accessType` is not requested at all
- web/apps/aquamobil/src/App.tsx:175 \-
  — the only PANEL_ONLY gate in the system is this client-side route redirect

  ```text
  if (isMobileDisabled || user?.accessType === 'PANEL_ONLY') return <Navigate to="/login" replace />;
  ```

- apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts:231 \-
  `accessType` is persisted and mutated but never consulted by any guard; repo-wide grep finds it
  only in entities, DTOs, migrations and lifecycle side-effects
- libs/backend-common/src/guards/mobile-feature.guard.ts:58 \- `canActivate` reads only
  `mobileFeatures`; no `accessType` dimension exists in any guard

**Rule violated:**

ADR-008 defense-in-depth (JWT → Tenant → Role/Feature); CLAUDE.md Security — UI-only hiding is never
an access boundary

**Proposed fix direction:**

Promote `accessType` from a UI hint to a signed authorization claim: mint it into the JWT alongside
`mobileFeatures`, and enforce it in one canonical guard that also derives the mobile-feature
decision, so 'no mobile platform access' and 'no mobile feature entitlement' are one fail-closed
check rather than two independent ones. Fix the biometric path at the contract layer — make
`accessType` non-nullable in the auth payload type so any login mutation selection set that omits it
fails to compile, instead of relying on each callsite remembering the check.

**Affected surface (ripple set):**

- `apps/auth-service/src/modules/authentication/services/token.service.ts`

  ```text
  apps/auth-service/src/modules/authentication/resolvers/ (webauthn verify login selection)
  ```

- `libs/backend-common/src/guards/mobile-feature.guard.ts`
- `web/apps/aquamobil/src/hooks/useAuth.tsx`
- `web/apps/aquamobil/src/hooks/useWebAuthn.ts`
- `web/apps/aquamobil/src/types/ (AuthState / AccessType)`

**Expected closer:**

auth-security-expert WRITER mode

**Verifier note:**

Core factual claim holds: repo-wide grep for `accessType` finds it only in user.entity.ts:144, DTOs
(tenant-role.dto.ts:437/498), migrations, and the lifecycle side-effects — no guard, resolver or
middleware consults it; useWebAuthn.ts VERIFY_LOGIN_MUTATION user selection is
`{id email firstName lastName role tenantId}` (no accessType) and loginWithToken (useAuth.tsx
~380-410) sets isAuthenticated after checkMobileEnabled only, storing a user object without
accessType. But the evidence overstates: 'the only PANEL_ONLY gate in the system is this client-side
route redirect' is false — there are three client gates (useAuth.tsx:279 password login,
useAuth.tsx:351, useMobilePermissions.ts:262) plus the SERVER-backed
`getMyMobileSettings.isMobileEnabled` check (checkMobileEnabled, fail-closed on error,
useAuth.tsx:150-168) which the biometric path DOES run, so a BOTH→PANEL_ONLY downgraded user is
blocked server-data-side. Severity: accessType is a surface preference, not an authority — mobile
and panel hit the same GraphQL API behind the same JWT/tenant/role/site/permission-matrix gates, so
bypassing it yields no data or action the user cannot already perform from the panel. The cited
biometric path is additionally near-unreachable: WebAuthn registration mutations exist only in the
aquamobil client and require an authenticated mobile session, which the password path denies for
PANEL_ONLY.

### PRODUCT-ACCESS-MEDIUM-004

**Title:** Regulatory field capture, attendance and leave-create entitlements are UI-only — five
mobile feature flags have no server guard anywhere

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-HIGH-002` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/fish-health/resolvers/field-capture.resolver.ts:120 \- `recordLiceCount` has
  ,
  :170 `requestIncidentMediaUpload`; class guard at :41 is `@UseGuards(TenantGuard)` with no
  `MobileFeatureGuard`

  ```text
  @Roles(...)` only; the same holds at :145 `recordWelfareAssessment`, :157 `recordEscapeIncident
  ```

- apps/hr-service/src/attendance/attendance.resolver.ts:386 \- `clockIn` carries neither `@Roles`
  nor is
  `@UseGuards(GqlAuthGuard)`

  ```text
  @RequiresMobileFeature('attendance')`; `:418` `clockOut` likewise; class guard at `:72
  ```

- apps/hr-service/src/leave/leave.resolver.ts:425 \- `createLeaveRequest` has no `@Roles` and no
  `@RequiresMobileFeature('leave')`, while `:471` `submitLeaveRequest` has

  ```text
  @UseGuards(RolesGuard, MobileFeatureGuard)` \+ `@RequiresMobileFeature('leave')
  ```

- apps/farm-service/src/regulatory/regulatory-report-draft.resolver.ts:131 \-
  mobile
  flag is never checked server-side

  ```text
  approveAndSubmitReportDraft` is `@Roles(TENANT_ADMIN, MODULE_MANAGER)` only; the `reports
  ```

- libs/backend-common/src/guards/roles.guard.ts:67 \- with no `@Roles` metadata the guard returns
  `true` for any authenticated user, so `clockIn`/`createLeaveRequest` are tenant-wide open

**Rule violated:**

Domain rule — 'Flag any feature flag that only hides the UI while the backend path remains enabled
and reachable'; ADR-008

**Proposed fix direction:**

Make the mobile feature vocabulary a single typed enum shared by the entity, the DTO, the client
`MobileFeature` union and the decorator, then require every operation reachable from the mobile
operation registry to declare its key. Enforce with a CI invariant that diffs
`MobileAllowedFeatures` keys against the set of `@RequiresMobileFeature` values actually reachable
behind a registered guard — an unreferenced key or an unguarded mobile mutation fails the build.

**Affected surface (ripple set):**

- `apps/farm-service/src/fish-health/resolvers/field-capture.resolver.ts`
- `apps/farm-service/src/fish-health/fish-health.module.ts`
- `apps/hr-service/src/attendance/attendance.resolver.ts`
- `apps/hr-service/src/attendance/attendance.module.ts`
- `apps/hr-service/src/leave/leave.resolver.ts`
- `apps/farm-service/src/regulatory/regulatory-report-draft.resolver.ts`
- `libs/backend-common/src/decorators/requires-mobile-feature.decorator.ts`
- `tests/invariants/ (new mobile-feature-coverage spec)`

**Expected closer:**

auth-security-expert WRITER mode

**Verifier note:**

Line-level facts hold (field-capture.resolver.ts:41 `@UseGuards(TenantGuard)` with @Roles-only
mutations at :120/:145/:157/:170; attendance.resolver.ts:72 `@UseGuards(GqlAuthGuard)` with
clockIn/clockOut carrying no @Roles or entitlement; leave.resolver.ts:425 createLeaveRequest
unguarded vs :471 submitLeaveRequest guarded; roles.guard.ts:67 returns true for any authenticated
user when no @Roles metadata). But the impact framing is refuted: clockIn/clockOut are NOT
'tenant-wide open' — both call resolveEmployee(userId, tenantId) and throw ForbiddenException('You
can only clock in for yourself') on a mismatched employeeId; createLeaveRequest enforces the same
self-only rule ('You can only create leave requests for yourself'), and the workflow step that
matters (submitLeaveRequest) IS entitlement-gated, so a `leave:false` user can only create an
unsubmitted draft. Field-capture and regulatory mutations retain a MODULE_USER/MODULE_MANAGER role
floor via the global RolesGuard plus farm-service's fail-closed PermissionMatrixGuard
(permission-matrix.ts:154-160). What remains is a genuine but bounded UI-only entitlement gap for
liceCount/welfare/escape/attendance/reports.

### PRODUCT-ACCESS-MEDIUM-006

**Title:** Tenant-admin mobile permission editor exposes 6 of 16 entitlements and its local defaults
silently revoke two features on first save

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-HIGH-004` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/modules/tenant-admin/src/components/settings/MobileSettings.tsx:19 \- `FEATURE_COLUMNS`
  renders only `mortality`, `cull`, `harvest`, `tankView`
- web/modules/tenant-admin/src/components/settings/MobileSettings.tsx:26 \-
  `DEFAULT_ALLOWED_FEATURES` hardcodes `feeding: false, waterQuality: false`, contradicting the
  server SSoT where both are `true`
- web/modules/tenant-admin/src/components/settings/MobileSettings.tsx:110 \- `saveMobileSettings`
  sends exactly six flags, so a save for a user with no loaded row writes
  `feeding:false, waterQuality:false`
- web/modules/tenant-admin/src/hooks/useTenantData.ts:807 \- the mutation input type is pinned to
  the same six fields
- apps/auth-service/src/modules/tenant/dto/mobile-settings.dto.ts:15 \- `MobileFeatureTogglesInput`
  already supports all 16 flags (its own comment records the earlier 7-flag drift as
  FARM-MEDIUM-215)

**Rule violated:**

Domain rule — 'Flag any role matrix where create/edit/delete/approve/export access is inconsistent
between page-level guards and control-level checks'; server-enforced authority with no product
affordance

**Proposed fix direction:**

Derive the editor's column set and its default map from the generated GraphQL schema types for
`MobileAllowedFeatures` rather than a hand-maintained literal, so adding a backend flag surfaces an
admin control automatically and a missing one is a type error. Remove the client-side default map
entirely — the server is the SSoT for an unprovisioned user's state, and the editor should render
server-returned values or an explicit 'not provisioned' state instead of inventing one.

**Affected surface (ripple set):**

- `web/modules/tenant-admin/src/components/settings/MobileSettings.tsx`
- `web/modules/tenant-admin/src/hooks/useTenantData.ts`
- `web/modules/tenant-admin/src/lib/api.ts`
- `web/modules/tenant-admin/src/lib/types.ts`
- `apps/auth-service/src/modules/tenant/entities/mobile-user-settings.entity.ts`

**Expected closer:**

frontend-expert WRITER mode

**Verifier note:**

Verified: MobileSettings.tsx:19-24 FEATURE_COLUMNS renders only 4 toggles (mortality, cull, harvest,
tankView — the claim says 6, the mutation payload is 6); DEFAULT_ALLOWED_FEATURES:26-33 hardcodes
feeding:false, waterQuality:false against a server SSoT of true; saveMobileSettings:110 sends
exactly six flags; useTenantData.ts:807 pins the same six; the server DTO (mobile-settings.dto.ts)
already supports all 16. Severity inflated to HIGH though: GET_MOBILE_USERS_SETTINGS_QUERY selects
the whole `allowedFeatures` JSON, so users WITH a persisted row round-trip their real
feeding/waterQuality values unchanged — the silent revoke only bites users with no row at all, and
per finding 001 essentially every user gets a row on their first token mint. The durable issue is
the product gap: 10 of 16 entitlements (transfer, schedule, attendance, leave, tasks, storage,
liceCount, welfare, escape, reports) have no admin affordance despite server support.

### PRODUCT-ACCESS-MEDIUM-007

**Title:** Mobile read surfaces are tenant-wide while the matching writes are site-scoped — tank
inventory, stock events (incl. HARVEST) and daily-ops counts ignore `assignedSiteIds`

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-HIGH-005` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/farm-stock/farm-stock.resolver.ts:11 \- `farmStockInventory` takes only
  `@CurrentTenant`; no `@CurrentUser` / site filter, and it is the mobile tank-list source
  (`web/apps/aquamobil/src/hooks/useTanks.ts:14` `FARM_STOCK_INVENTORY_QUERY`)
- apps/farm-service/src/mobile-dashboard/handlers/get-stock-events-summary.handler.ts:39 \-
  `where = { tenantId, operationType: In(STOCK_EVENT_OPERATION_TYPES), ... }` with
  `OperationType.HARVEST` included at `:21`, returning the 10 most recent events tenant-wide
- apps/farm-service/src/mobile-dashboard/handlers/get-todays-daily-ops-counts.handler.ts:50 \- every
  aggregate filters on `tenantId` only
- apps/farm-service/src/feeding-protocol/resolvers/meal-execution.resolver.ts:88 \- the contrasting
  correct shape:

  ```text
  if (!isManagerOrHigher) { const assigned = user.assignedSiteIds ?? []; if (assigned.length === 0) return []; qb.andWhere('plan.siteId IN (:...assigned)') }
  ```

- web/apps/aquamobil/src/components/MultiFeatureRoute.tsx:62 \- `features.some((f) => canReach(f))`
  — a `transfer`-only MODULE_USER enters `/operations/stock` and sees the harvest-bearing summary
  they may not write

**Rule violated:**

SEC-HIGH-051 object-level site authorization; CLAUDE.md Security — tenant/site scoping must hold on
reads and writes alike

**Proposed fix direction:**

Thread the caller's site assignment into the mobile read path the same way the write path already
does, and make it structural: the query objects for these mobile reads should carry a non-optional
caller-scope value object (tenant \+ roles \+ assignedSiteIds) so a handler cannot be constructed
without it, rather than each handler remembering to filter. Route the mobile dashboard aggregates
through the same scope resolver `feedingDayPlans` uses so there is one fail-closed site filter, not
per-handler copies.

**Affected surface (ripple set):**

- `apps/farm-service/src/farm-stock/farm-stock.resolver.ts`
- `apps/farm-service/src/farm-stock/queries/get-farm-stock-inventory.query.ts`
- `apps/farm-service/src/mobile-dashboard/mobile-dashboard.resolver.ts`

  ```text
  apps/farm-service/src/mobile-dashboard/handlers/get-stock-events-summary.handler.ts
  ```

  ```text
  apps/farm-service/src/mobile-dashboard/handlers/get-todays-daily-ops-counts.handler.ts
  ```

- `apps/farm-service/src/mobile-dashboard/queries/*.ts`

**Expected closer:**

tenant-isolation-auditor handoff, then farm-domain expert WRITER mode

**Verifier note:**

Verified: farm-stock.resolver.ts:11-19 takes @CurrentTenant only (no @CurrentUser, no
assignedSiteIds filter) and is the mobile tank source (useTanks.ts FARM_STOCK_INVENTORY_QUERY);
get-stock-events-summary.handler.ts:39-44 filters on tenantId \+ operationType (HARVEST included at
:21) and returns the 10 most recent tenant-wide; get-todays-daily-ops-counts.handler.ts aggregates
on tenantId only; meal-execution.resolver.ts:89 and feed-forecast.resolver.ts:81 show the correct
fail-closed site-scoped read shape. Severity lowered: this is read-only, intra-tenant aggregate
exposure (tank inventory, counts, recent event list) with no cross-tenant leak and no write
capability; site scoping is consistently enforced on the write paths (SEC-HIGH-051 threading in
feeding, harvest, water-quality, storage). Confidentiality impact of same-tenant fish counts to an
authenticated MODULE_USER is moderate, not HIGH.

### PRODUCT-ACCESS-MEDIUM-008

**Title:** Mobile feature flags also gate the desktop path for the same mutation — the mobile
permission editor silently governs web capability

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-HIGH-006` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- libs/backend-common/src/guards/mobile-feature.guard.ts:58 \- `canActivate` has no client/surface
  discriminator; it denies the mutation for any non-admin whose `mobileFeatures` claim lacks the
  key, regardless of origin
- apps/farm-service/src/batch/resolvers/batch.resolver.ts:362 \-
  `@RequiresMobileFeature('mortality')` on `recordMortality`, the same mutation the desktop calls
- web/modules/farm-module/src/pages/production/components/MortalityModal.tsx \- desktop
  `recordMortality` callsite
- apps/farm-service/src/water-quality/water-quality.resolver.ts:290 \-
  `@RequiresMobileFeature('waterQuality')` on `createWaterQualityMeasurement`, called from
  `web/modules/farm-module/src/hooks/useWaterQuality.ts`
- apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:354 \-
  `@RequiresMobileFeature('harvest')` on `createHarvestRecord`, a manager operation performed from
  both surfaces

**Rule violated:**

Domain rule — 'Flag any mobile permission surface that diverges from the web permission model for
the same business action'

**Proposed fix direction:**

Decide and encode the intended semantics rather than leaving it implicit: either the entitlement is
a `*mobile-surface*` gate — in which case the guard must key off a verified surface/audience claim
minted at login (not a client-supplied header) and be inert for panel-issued tokens — or it is a
`*capability*` gate, in which case rename it and surface it in the tenant-admin role/permission
editor as a platform-wide capability with a matching desktop affordance. Encode the choice as an ADR
so the two editors cannot drift again.

**Affected surface (ripple set):**

- `libs/backend-common/src/guards/mobile-feature.guard.ts`
- `libs/backend-common/src/decorators/requires-mobile-feature.decorator.ts`
- `apps/auth-service/src/modules/authentication/services/token.service.ts`
- `web/modules/tenant-admin/src/components/settings/MobileSettings.tsx`
- `web/modules/farm-module/src/hooks/useWaterQuality.ts`
- `docs/adr/ (new ADR: mobile entitlement vs platform capability)`

**Expected closer:**

architectural-arbiter ruling, then auth-security-expert WRITER mode

**Verifier note:**

Verified: mobile-feature.guard.ts has no surface/origin discriminator — it reads only the
mobileFeatures claim (with a TENANT_ADMIN+ bypass) and applies to every caller;
batch.resolver.ts:362 @RequiresMobileFeature('mortality') on recordMortality, which the desktop
calls (farm-module useBatches.ts:748/872 via MortalityModal.tsx:47); water-quality.resolver.ts:290
on createWaterQualityMeasurement (farm-module useWaterQuality.ts:284); harvest.resolver.ts:354 on
createHarvestRecord. So a tenant admin flipping a 'mobile' toggle silently removes the desktop
capability for non-admin users. Severity lowered from HIGH: the coupling fails in the DENY direction
(no privilege escalation), the actor is a tenant admin acting deliberately, defaults are all-true,
and TENANT_ADMIN+ bypasses the guard entirely — this is a permission-model coherence/naming defect,
not a security boundary failure.

### PRODUCT-ACCESS-MEDIUM-009

**Title:** `tankView` is a dead permission control — rendered as an admin toggle, consulted by no UI
gate and no server guard

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-MEDIUM-001` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/modules/tenant-admin/src/components/settings/MobileSettings.tsx:23 \-
  `{ key: 'tankView' as const, label: 'Tank View' }` is one of only four toggles the admin sees
- web/apps/aquamobil/src/hooks/useMobilePermissions.ts:9 \- `tankView` is declared in the
  `MobileFeature` union; repo grep finds it only in the type, the two default maps and tests — no
  `canAccess('tankView')` / `canReach('tankView')` callsite exists
- web/apps/aquamobil/src/App.tsx:237 \-

  ```text
  <Route path="/tank/:tankId" element={<TankDetailPage2 />} />` is not wrapped in `FeatureRoute
  ```

- apps/farm-service/src/farm-stock/farm-stock.resolver.ts:11 \- the backing `farmStockInventory`
  query carries `@Roles` only, no `@RequiresMobileFeature('tankView')`

**Rule violated:**

Domain rule — 'UI-only hiding is never sufficient'; here the control is neither UI nor server, it is
inert at every layer

**Proposed fix direction:**

Close the loop at the type level: make `MobileFeature` exhaustively consumed by requiring each key
to appear in a route/CTA gate map that the router derives from, so an unconsumed key fails to
compile. Then either wire `tankView` to the `/tank/:tankId` route plus the tank-list read, or delete
the flag from the entity, DTO, client union and admin editor in one change — an admin control that
does nothing is worse than no control.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useMobilePermissions.ts`
- `web/apps/aquamobil/src/App.tsx`
- `web/apps/aquamobil/src/utils/feature-access.ts`
- `web/modules/tenant-admin/src/components/settings/MobileSettings.tsx`
- `apps/auth-service/src/modules/tenant/entities/mobile-user-settings.entity.ts`
- `apps/farm-service/src/farm-stock/farm-stock.resolver.ts`

**Expected closer:**

frontend-expert WRITER mode

**Verifier note:**

Every cited line holds. web/modules/tenant-admin/src/components/settings/MobileSettings.tsx:23
renders `{ key: 'tankView', label: 'Tank View' }` as one of only four admin columns, and :115
persists it on save, so the flag round-trips to auth.mobile_user_settings and into the JWT
`mobileFeatures` claim (token.service.ts getUserMobileFeatures projects every truthy key).
web/apps/aquamobil/src/hooks/useMobilePermissions.ts:9 declares 'tankView' in the MobileFeature
union and :79/:104 in the two all-false default maps. A repo-wide grep for tankView finds it ONLY in
the union, the default maps, the tenant-admin editor/types, the auth DTO/entity/migrations and
aquamobil tests \- there is no canAccess('tankView')/canReach('tankView') callsite in any non-test
file. web/apps/aquamobil/src/App.tsx:237 is
`<Route path="/tank/:tankId" element={<TankDetailPage2 />} />` with no FeatureRoute wrapper;
MobileLayout.tsx's tab filter (:98-103) never lists tankView in any tab's `features`; TankCard.tsx
gates only mortality/cull/harvest/transfer. Server side,
apps/farm-service/src/farm-stock/farm-stock.resolver.ts:11 carries
`@Roles(TENANT_ADMIN, MODULE_MANAGER, MODULE_USER)` only, and a repo-wide grep of
@RequiresMobileFeature(...) across apps/ yields exactly
cull/feeding/harvest/leave/mortality/storage/tasks/transfer/waterQuality \- no 'tankView' decorator
exists anywhere. So the toggle is inert at route, CTA, tab and resolver layers. MEDIUM is correct,
not inflated: it is a misleading admin control (an admin who revokes Tank View changes nothing)
rather than a privilege escalation \- the underlying data stays role-gated and tenant-scoped.

### PRODUCT-ACCESS-MEDIUM-010

**Title:** Entitlement revocation is invisible to the client for up to 8 hours — permissions are not
re-fetched on token refresh

**Severity:** MEDIUM
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-MEDIUM-002` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/hooks/useMobilePermissions.ts:296 \- effect deps are
  `[isAuthenticated, authLoading, user?.id, tenantId]`; `accessToken` is deliberately excluded
  (BUG-16), so a token refresh carrying a revoked `mobileFeatures` claim never triggers a re-fetch
- web/apps/aquamobil/src/hooks/useMobilePermissions.ts:193 \- cache TTL is
  `Date.now() + 8 * 60 * 60 * 1000` (one work shift)
- web/apps/aquamobil/src/hooks/useMobilePermissions.ts:317 \- `refreshPermissions` exists but is
  wired only to a manual banner button (`web/apps/aquamobil/src/pages/HomePage.tsx:221`)
- apps/auth-service/src/modules/authentication/services/token.service.ts:79 \- the claim's own
  contract comment: 'a disabled feature stays effective until the next token refresh'

**Rule violated:**

Domain rule — read-only/stale affordance drift; CLAUDE.md Working Style (surfaces must not promise
authority the server will refuse)

**Proposed fix direction:**

Bind the client permission snapshot to the token identity rather than to the user identity: derive
the entitlement set from the access token's own `mobileFeatures` claim (already present and already
the server's authority) so a refresh automatically re-derives it, and keep the IndexedDB copy purely
as an offline last-known-good keyed by token issue time. That makes 'UI shows a feature the current
token cannot exercise' structurally impossible while online.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useMobilePermissions.ts`
- `web/apps/aquamobil/src/hooks/useAuth.tsx`
- `web/apps/aquamobil/src/utils/jwt-claims.ts`
- `web/apps/aquamobil/src/utils/feature-access.ts`

**Expected closer:**

frontend-expert WRITER mode

**Verifier note:**

Cited lines are exact: useMobilePermissions.ts:296 is
`}, [isAuthenticated, authLoading, user?.id, tenantId]);` with an in-code BUG-16 comment stating
fetchSettings is read via a ref specifically so the effect does NOT re-run on token refresh; :193
writes the IndexedDB cache with `expiresAt: Date.now() + 8*60*60*1000`; :317 exposes
`refreshPermissions: fetchSettings`, and HomePage.tsx:218-221 wires it to a button rendered ONLY
inside `{permissionsDegraded && ...}` \- so in the normal (non-degraded) case there is no
user-reachable refresh path at all, which is worse than the finding states. token.service.ts:79-81
carries the cited contract comment ('a disabled feature stays effective until the next token
refresh'). I checked for compensating triggers: no visibilitychange, focus or setInterval refetch
exists in useMobilePermissions.ts or useAuth.tsx, so within a mounted PWA session the entitlement
snapshot is never re-derived. Two precision corrections that do not change the verdict: (a) the
client never reads the `mobileFeatures` claim (grep finds zero references in aquamobil), so the
mechanism is 'the separate getMyMobileSettings snapshot is never re-fetched', not 'a refreshed claim
is ignored'; (b) 'up to 8 hours' understates it \- on a warm session the stale window is the session
lifetime, unbounded; the 8h TTL only bounds the offline last-known-good. Impact is bounded to
affordance drift (MobileFeatureGuard denies guarded mutations server-side once the claim is
re-minted at `<=15m`), which is why MEDIUM rather than HIGH is right \- but it is real: a revoked
user keeps seeing CTAs and can enqueue offline writes that will 403 on replay.

### PRODUCT-ACCESS-MEDIUM-011

**Title:** `checkMobileEnabled` still fails open on a missing or null field — residual of
prior-cycle HIGH-001 Path 1

**Severity:** MEDIUM
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-MEDIUM-003` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** NOT VERIFIED — no verifier returned a verdict for this id

**Evidence:**

- web/apps/aquamobil/src/hooks/useAuth.tsx:163 \-
  `return result.data?.getMyMobileSettings?.isMobileEnabled ?? true;` — a malformed body, a null
  payload or a GraphQL error envelope with no data yields ALLOW
- web/apps/aquamobil/src/hooks/useAuth.tsx:167 \- the `catch` correctly returns `false`, so only the
  parse path is inconsistent
- docs/product-audits/access-boundary-auditor/2026-04-13-full-platform-e2e.md:38 \- prior cycle
  raised exactly this `?? true` fallback; the catch branch was fixed, the coalesce was not

**Rule violated:**

CLAUDE.md Security — fail-closed; CLAUDE.md Architectural Approach (no defensive/permissive `??`
bridging a missing upstream field)

**Proposed fix direction:**

Remove the ambiguity at the contract, not the callsite: make `isMobileEnabled` non-nullable in the
generated result type and route the response through the existing `readGraphQLResponse` validation
so an absent field is a parse failure that lands in the fail-closed catch. The literal `true`
default should not be expressible in this function.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useAuth.tsx`
- `web/apps/aquamobil/src/utils/graphql-response.ts`
- `web/apps/aquamobil/src/generated/graphql.ts`
- `apps/auth-service/src/modules/tenant/entities/mobile-user-settings.entity.ts`

**Expected closer:**

frontend-expert WRITER mode

### LOW

### PRODUCT-ACCESS-LOW-005

**Title:** `MobileFeatureGuard` is opt-in per resolver with no invariant, so
`@RequiresMobileFeature` is silently inert wherever the guard was not wired

**Severity:** LOW (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-HIGH-003` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- libs/backend-common/src/guards/mobile-feature.guard.ts:65 \-
  `if (!requiredFeature) { return true; }` — the guard is a no-op without metadata, and
  symmetrically the metadata is a no-op without the guard
- apps/farm-service/src/batch/resolvers/batch.resolver.ts:125 \-
  `@UseGuards(GqlAuthGuard, MobileFeatureGuard)` — enforcement depends on each resolver remembering
  the guard
- apps/farm-service/src/batch/batch.module.ts:147 \- `MobileFeatureGuard` must also be added to each
  module's providers; six farm modules and one hr module do this individually
- apps/farm-service/src/app.module.ts:535 \- `RolesGuard` IS registered as a global `APP_GUARD`;
  `MobileFeatureGuard` is absent from that list
- apps/farm-service/src/app.module.ts:560 \- `PermissionMatrixGuard` is global and fail-closed for
  unknown mutations, demonstrating the pattern the entitlement guard should follow

**Rule violated:**

layer-1-nestjs.md 'Guard order — JWT → Tenant → Role/Feature; ADR-008 defense-in-depth requires all
three active'; CLAUDE.md Architectural Approach tier 1/3

**Proposed fix direction:**

Register the entitlement guard as a global `APP_GUARD` in every service that hosts a
mobile-reachable mutation, matching the existing `RolesGuard` / `PermissionMatrixGuard`
registrations — the guard is already a no-op on un-annotated routes, so global registration is
behaviour-preserving and removes the per-resolver failure mode. Add an adoption invariant in
`tests/invariants/` asserting global registration in each such service, mirroring the existing
`SchemaDriftModule.forRoot` adoption invariant.

**Affected surface (ripple set):**

- `apps/farm-service/src/app.module.ts`
- `apps/hr-service/src/app.module.ts`
- `apps/alert-engine/src/app.module.ts`

  ```text
  apps/farm-service/src/{batch,harvest,feeding,task,storage,water-quality}/*.module.ts
  ```

- `apps/hr-service/src/leave/leave.module.ts`
- `tests/invariants/ (new guard-adoption spec)`

**Expected closer:**

platform-kernel-expert WRITER mode

**Verifier note:**

Structural facts verified: mobile-feature.guard.ts:65 returns true without metadata; the guard must
be added per resolver AND per module providers; farm app.module.ts registers RolesGuard (:535) and
PermissionMatrixGuard (:560) as APP_GUARDs but not MobileFeatureGuard; and a repo-wide spec grep
finds only `libs/backend-common/src/guards/**tests**/mobile-feature.guard.spec.ts` — no pairing
invariant. However the claimed consequence has ZERO live instances: every file that carries
@RequiresMobileFeature (water-quality, feeding-program, harvest, task, storage, batch resolvers, and
leave.resolver per-method) also wires MobileFeatureGuard on the class/method, so no metadata is
currently inert. This is a latent tier-3 architectural gap (missing invariant), not a reachable
bypass — HIGH is inflated.

### PRODUCT-ACCESS-LOW-012

**Title:** Alerts, notifications and messaging mobile surfaces have no entitlement key — they cannot
be revoked per user from any product surface

**Severity:** LOW
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-ACCESS-LOW-001` by `access-boundary-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/App.tsx:317 \- `<Route path="/alerts" element={<AlertsPage />} />` with no

  ```text
  FeatureRoute`; same for `/notifications` at `:316` and `/messages*` at `:276`-`:282
  ```

- apps/alert-engine/src/alert/resolvers/alert.resolver.ts:156 \- `acknowledgeAlert` is
  `@Roles(TENANT_ADMIN, MODULE_MANAGER, MODULE_USER)` with no mobile entitlement dimension
- web/apps/aquamobil/src/pwa/operation-registry.ts:227 \- `acknowledgeAlert` is an offline-queued
  mobile command, i.e. a first-class mobile write action
- web/apps/aquamobil/src/hooks/useMobilePermissions.ts:9 \- the `MobileFeature` union has no
  `alerts`, `notifications` or `messaging` key

**Rule violated:**

Domain rule — every mobile action must have an identifiable claimed access rule; here the rule is
'any authenticated tenant user', which may be intended but is undeclared

**Proposed fix direction:**

Make the entitlement vocabulary exhaustive over mobile write actions: every operation present in the
offline operation registry must map to a declared feature key (which may be an explicit
`alwaysAvailable` marker), enforced by the same coverage invariant proposed for
PRODUCT-ACCESS-HIGH-002. That converts today's silent omission into an explicit, reviewable product
decision.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/hooks/useMobilePermissions.ts`
- `web/apps/aquamobil/src/pwa/operation-registry.ts`
- `web/apps/aquamobil/src/App.tsx`
- `apps/alert-engine/src/alert/resolvers/alert.resolver.ts`
- `apps/auth-service/src/modules/tenant/entities/mobile-user-settings.entity.ts`

**Expected closer:**

mobile-app-auditor handoff, then frontend-expert WRITER mode

**Verifier note:**

All four evidence lines are exact. web/apps/aquamobil/src/App.tsx:317
`<Route path="/alerts" element={<AlertsPage />} />`, :316 `/notifications`, and :276-282 the seven
`/messages*` routes \- none wrapped in FeatureRoute or MultiFeatureRoute (I read the surrounding
block; the wrapped routes at :299-311 show the contrast). MobileLayout.tsx confirms it at the nav
layer too: the 'messages' tab entry carries no `features` array, so the filter at :98-100
(`if (!tab.features) return true;`) always shows it.
apps/alert-engine/src/alert/resolvers/alert.resolver.ts:155-156 is
with no
MobileFeatureGuard/@RequiresMobileFeature on the method or the class (:34-35 AlertResolver declares
no @UseGuards). web/apps/aquamobil/src/pwa/operation-registry.ts:227 registers `acknowledgeAlert` as
an offline-queued mobile command. useMobilePermissions.ts:9 union has no
alerts/notifications/messaging key. So the factual claim \- these mobile surfaces have no per-user
entitlement key and cannot be revoked feature-wise \- is true, and it is not a decision the code
documents anywhere (no comment or ADR marks these as deliberately always-available). LOW is the
right ceiling and I would not raise it: the access rule is not absent, only coarser (three-role gate
on ack, channel ACLs in messaging-service), an admin can still revoke via role change or
isMobileEnabled, and the gap is a vocabulary/coverage omission rather than a reachable bypass.

```text
@Mutation(... 'acknowledgeAlert')` \+ `@Roles(TENANT_ADMIN, MODULE_MANAGER, MODULE_USER)
```

## Inventory — what exists / what is missing

| Status          | Area                                                                                     | Note                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MISSING**     | Impersonation on mobile                                                                  | Correctly absent — no impersonation surface, session state or act-as header exists anywhere in aquamobil; the flow remains admin-panel-only. No impersonation state leaks into the mobile session.                                                                                  |
| **MISSING**     | Mobile entitlement provisioning \+ accessType boundary                                   | No fail-closed provisioning: an absent settings row is auto-created all-true on the token-mint read path, and accessType is enforced only by a client-side route redirect. The one server-side compensating control (deactivate-on-PANEL_ONLY) is best-effort and swallows failure. |
| **MISSING**     | Tank view / tank detail (tankView flag)                                                  | The flag is offered as an admin toggle but consulted nowhere: the /tank/:tankId route is unwrapped, no canAccess/canReach callsite exists, and farmStockInventory carries no entitlement guard.                                                                                     |
| **PARTIAL**     | Alert acknowledge (/alerts)                                                              | Role-gated (three roles) and offline-queue capable, but no mobile entitlement key and no FeatureRoute — it cannot be revoked per user from any surface.                                                                                                                             |
| **PARTIAL**     | Attendance clock in / clock out (/attendance)                                            | Self-scope is enforced (caller may only clock themselves, verified against the resolved Employee), but there is no @Roles and no 'attendance' entitlement guard — any authenticated tenant user can call it.                                                                        |
| **PARTIAL**     | Escape incident (/escape/record)                                                         | UI-only entitlement on a legally-immediate reporting path; recordEscapeIncident is role-gated only. Incident media presign shares the gap.                                                                                                                                          |
| **PARTIAL**     | Leave request — create                                                                   | createLeaveRequest has neither @Roles nor the 'leave' entitlement guard, unlike its submit/cancel/update/withdraw siblings which carry both. The mobile queue chains create → submit, so the submit step still fails closed.                                                        |
| **PARTIAL**     | Lice count capture (/lice/record)                                                        | UI-only entitlement. recordLiceCount enforces roles (MODULE_USER upward) but no 'liceCount' feature guard; the resolver class carries TenantGuard only.                                                                                                                             |
| **PARTIAL**     | Mobile dashboard aggregates (todaysDailyOpsCounts, stockEventsSummary, warehouseSummary) | Role-gated via the permission matrix, but tenant-wide with no site scoping and no entitlement key; stockEventsSummary surfaces HARVEST rows to users who cannot write harvests.                                                                                                     |
| **PARTIAL**     | My schedule (/schedule)                                                                  | Read-only surface gated by FeatureRoute 'schedule' in the client; no corresponding server-side entitlement key exists for the backing reads.                                                                                                                                        |
| **PARTIAL**     | Notifications \+ messaging (/notifications, /messages)                                   | Routes are ungated by any mobile feature key; messaging authorization lives in messaging-service channel ACLs (out of this audit's read set) rather than in the mobile entitlement model.                                                                                           |
| **PARTIAL**     | Record feeding — v2 meal path (recordMealFeeding / skipMeal)                             | UI-only entitlement. Role gate and in-transaction site authorization are present, but the 'feeding' mobile entitlement is not enforced on the live cutover path while the legacy recordDailyFeeding still enforces it.                                                              |
| **PARTIAL**     | Regulatory report review / approve (/reports)                                            | Role boundary agrees on both sides (client MODULE_MANAGER floor mirrors @Roles(TENANT_ADMIN, MODULE_MANAGER)), but the 'reports' mobile entitlement is UI-only. Correctly online-only — no offline queue path.                                                                      |
| **PARTIAL**     | Server-side mobile entitlement guard (MobileFeatureGuard)                                | The guard itself is correct and fail-closed (missing claim denies, admin bypass via role hierarchy), but it is registered per resolver/module rather than as a global APP_GUARD, and no invariant binds decorator to guard.                                                         |
| **PARTIAL**     | Tenant-admin mobile permission editor                                                    | Backend DTO supports all 16 flags, but the editor renders 4 columns and saves 6 fields; 10 server-enforced entitlements have no admin affordance and the editor's local defaults contradict the server SSoT.                                                                        |
| **PARTIAL**     | Welfare assessment (/welfare/record)                                                     | UI-only entitlement, same shape as lice count — role gate present, 'welfare' flag unenforced server-side.                                                                                                                                                                           |
| **IMPLEMENTED** | JWT lifecycle: expiry, refresh rotation, offline replay authz                            | Single-flight refresh prevents reuse-detection false logouts, refresh failure forces a fail-closed logout with a re-armed readiness barrier, and the service-worker replay lane mints a fresh token from the httpOnly cookie so queued commands never execute on stale claims.      |
| **IMPLEMENTED** | Leave request — submit / cancel / withdraw                                               | Gated correctly: @UseGuards(RolesGuard, MobileFeatureGuard) plus @RequiresMobileFeature('leave'), with ownership asserted transactionally in the handler.                                                                                                                           |
| **IMPLEMENTED** | Record cull (/cull/record)                                                               | Gated correctly. Same triple-layer shape as mortality; matrix entry allows MODULE_USER, entitlement enforced server-side.                                                                                                                                                           |
| **IMPLEMENTED** | Record harvest (/harvest/record)                                                         | Gated correctly including the role floor: the client feature-access SSoT pins harvest to MODULE_MANAGER, matching @Roles(MODULE_MANAGER, TENANT_ADMIN) on createHarvestRecord, plus the 'harvest' entitlement guard.                                                                |
| **IMPLEMENTED** | Record mortality (/mortality/record)                                                     | Gated correctly at all three layers: FeatureRoute 'mortality', @Roles(ADMIN/MANAGER/USER) in the fail-closed permission matrix, and @RequiresMobileFeature('mortality') behind a registered MobileFeatureGuard.                                                                     |
| **IMPLEMENTED** | Record transfer (/transfer/record, transferBatch)                                        | Gated correctly; allocateBatchToTank and recordGrading share the same 'transfer' entitlement key so sibling operations cannot be used as a bypass.                                                                                                                                  |
| **IMPLEMENTED** | Storage stock movement / transfer (`/storage/*`)                                         | Gated correctly at route, role and entitlement layers for both recordStockMovement and transferStock.                                                                                                                                                                               |
| **IMPLEMENTED** | Task lifecycle (start / complete / checklist / note)                                     | Gated correctly; all five task mutations carry @RequiresMobileFeature('tasks') behind a registered guard, and the at-most-once envelope is mandatory server-side.                                                                                                                   |
| **IMPLEMENTED** | Water quality record (/water-quality/record)                                             | Gated correctly with an additional @Throttle; entitlement, roles and matrix entry all agree.                                                                                                                                                                                        |

## Verdict

BLOCK

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/access-boundary-auditor.md`
- Rule SSoT: `CLAUDE.md`
