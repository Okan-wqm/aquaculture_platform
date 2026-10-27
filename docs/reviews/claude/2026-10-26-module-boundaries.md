# Module boundaries program: findings (2026-10-26)

Findings registered for the Company umbrella program, under the owner decisions of 2026-10-26
(Company is the umbrella over the common kinds of every module; module-private data is never
reachable from Company; HR is a module; salary stays in HR). The program is defined by ADR 051
(module access layers), ADR 052 (module-keyed common registry) and ADR 053 (PG16 constant-default
ADD COLUMN).

One finding per defect. Each finding names the package that closes it in its notes, and the
commits of that package carry a Closes trailer that points at its heading below. The defects are
stated as they exist in the code today, never as the solution.

## DEPLOY-MEDIUM-029

Defect. The migration-authoring runbook bans ADD COLUMN NOT NULL DEFAULT on populated tables as a
full-row rewrite, which is false for constant defaults on the production PostgreSQL 16 and
contradicts the migration-sql-lint gate, steering authors to a heavier three-step path.

Package PKG-00, release R1, severity MEDIUM.

Where. `docs/runbooks/migration-authoring.md:178` bans `ALTER TABLE ADD COLUMN NOT NULL DEFAULT
...` on a populated table because it 'rewrites every row in one tx'. It prescribes a nullable add,
then a backfill, then SET NOT NULL instead.

Root cause. The row describes pre-PostgreSQL-11 behaviour. Since PG11, a non-volatile default is
stored in the catalog and the table is not rewritten. Production runs PG16
(`Dockerfile.postgres-walg:6`). The gate `R2-single-step-add-not-null`
(`migration-sql-lint.ts:442-454`) already encodes the correct rule and flags only NOT NULL without
DEFAULT, so the runbook and the gate disagree. The prescribed path is also heavier: `SET NOT NULL`
scans the whole table under ACCESS EXCLUSIVE, and under C3 the three steps span three releases.

Fix tier. 3 (detectable), plus the document change. ADR 053 amends the row to separate constant
defaults from volatile ones. A libs/migration-harness spec on real Postgres asserts that
`relfilenode` does not change after a constant-default add.

Pinned by. That harness spec. The existing gate keeps flagging missing defaults.

Rule broken. Repo rule that a runbook states engine behaviour truthfully and agrees with the gate
that enforces it (plan section 3, ADR 053 runbook amendment)

Evidence:

```text
docs/runbooks/migration-authoring.md:178 (bans ADD COLUMN NOT NULL DEFAULT, claiming it rewrites every row in one transaction)
tools/gates/migration-sql-lint.ts:442-454 (rule R2 flags only NOT NULL without DEFAULT)
infrastructure/docker/Dockerfile.postgres-walg:6 (production Postgres is timescaledb-ha pg16)
docker-compose.infra.yml:12 (CI and local infrastructure run the same pg16 image)
```

## PROC-MEDIUM-064

Defect. Module access has no architectural decision record: no ADR in docs/adr owns the
module-access layers, the per-module grant claim or the enforcement order, so the boundary exists
only in an entity comment and a web helper.

Package PKG-00, release R1, severity MEDIUM.

Where. `docs/adr/` has no record that decides who may read what per module. ADR-008 covers only
admin-api's PlatformAdminGuard, and the ADR index in `CLAUDE.md:179` names nothing on module
access. The boundary is stated only in a code comment (`user-module-assignment.entity.ts:19-29`)
and applied only by the web nav (`AuthContext.tsx:222-232`). The gateway copies the `modules`
claim (`tenant-isolation.guard.ts:233`) and nothing decides on it.

Root cause. Module boundaries grew as console navigation. No decision ever fixed the access kinds,
the claim shape, the enforcement order or the cross-release contract rules. Each service worked
them out separately, which produced the six module-code copies and the split role hierarchy
registered next to this finding.

Fix tier. 4 (document). It anchors the tier-1 and tier-3 work. ADR 051 records the decision table,
the `moduleAccess` claim, the enforcement order and C1-C8. The architectural-arbiter approves it
before PKG-01 lands.

Pinned by. The registry schema and hash-chain check on the new rows, plus the commit-msg
validator, which resolves every later `Closes:` anchor to a registered finding.

Rule broken. Plan section 3 prerequisite (ADR 051 Module access layers, approved by
architectural-arbiter before code lands) and owner decision D2, which needs a recorded boundary
that every service enforces

Evidence:

```text
docs/adr/008-guard-strategy-defense-in-depth.md:11-24 (the only guard ADR covers admin-api PlatformAdminGuard layering, nothing on tenant module grants)
CLAUDE.md:179 (the ADR index lists no module-access decision)
apps/auth-service/src/modules/authentication/entities/user-module-assignment.entity.ts:19-29 (module access semantics stated only in an entity doc comment)
apps/gateway-api/src/guards/tenant-isolation.guard.ts:233 (the modules claim is copied into TenantContext and never decided on)
web/shared-ui/src/contexts/AuthContext.tsx:222-232 (the only module-access rule lives in the web client)
```

## HR-MEDIUM-064

Defect. departments_hr.moduleCode cannot hold hr: the HrModuleCode enum and its Postgres type list
only farm, hydroponics and sensor, so an HR-owned organisation unit can only be stored as NULL,
which hr-service reads as company-wide.

Package PKG-01, release R1, severity MEDIUM.

Where. hr-service keys every department by module through `departments_hr.moduleCode`. The TS enum
(`enums.ts:32-36`) and the Postgres type created by
`1802400000000-AddDepartmentHrModuleCode.ts:31` accept only farm, hydroponics and sensor. HR's own
units therefore have no value to carry. They are stored as NULL, which `department.entity.ts:33`
and `module-scope.ts:15` define as company-wide.

Root cause. The enum was cut as the set of production workspaces that had a Team area, and hr was
left out. The parity spec only checks that it is a subset of auth's codes, so the omission is
legal. NULL now means both 'company-wide' and 'HR-owned'. D7 (move NULL HR units to hr) cannot
run, because the value exists in neither the TS enum nor the Postgres type.

Fix tier. 1 (impossible). The department enum derives from the owner-module dictionary. A
type-guarded `ALTER TYPE ... ADD VALUE 'hr'` migration with `transaction = false` adds the label,
following
`apps/farm-service/src/database/migrations/1805900000000-AddChemicalTherapeuticTypes.ts`. The
counted move of NULL rows to hr is PKG-18 under D7.

Pinned by. module-dictionary-ssot (replayed Postgres labels equal the dictionary) and a
migration-harness replay spec.

Rule broken. Owner decisions D4 (hr is an owner module) and D7 (HR departments with a NULL module
move to hr, with counts reported)

Evidence:

```text
apps/hr-service/src/common/enums.ts:24-36 (no module means company-wide; the enum has no hr value)
apps/hr-service/src/hr/entities/department.entity.ts:33-36 (moduleCode typed HrModuleCode, null documented as company-wide)
apps/hr-service/src/database/migrations/1802400000000-AddDepartmentHrModuleCode.ts:31 (departments_hr_modulecode_enum created with farm, hydroponics, sensor)
apps/hr-service/src/common/module-scope.ts:15 (an absent module is the Company view, every module)
apps/auth-service/src/modules/system-module/entities/module.entity.ts:16-23 (hr is a tenant module code)
```

## RBAC-MEDIUM-023

Defect. Module codes are declared in six independent source copies (auth ModuleCode, hr
HrModuleCode, alert AlertModule, the AI specialty type, the web nav union and a tenant-admin
literal) whose member sets already disagree, and no check ties them to one dictionary.

Package PKG-01, release R1, severity MEDIUM.

Where. Six places declare which modules exist, and their sets differ. Auth has six codes,
including alert and ai. hr-service and alert-engine each have three and omit hr. The AI specialty
type has only farm. The web nav has four. Two more untyped copies exist:
`permission-catalogue.ts:131` (`ai_specialties` with actions `['farm']`) and
`libs/event-contracts/src/tenant-events.ts:289` (`moduleCodes?: string[]`).

Root cause. No library owns the module vocabulary, and nothing separates owner modules (D4) from
platform modules (alert, ai). Each service typed the subset it needed. The only check,
`tests/invariants/hr-module-code-parity.spec.ts`, pins that hr's codes are a subset of auth's, so
a code missing everywhere except auth still passes.

Fix tier. 1 (impossible): frozen constants and type guards in
`libs/shared-contracts/src/modules/platform-modules.ts`. The TS enums are deleted and every
consumer derives from the dictionary. 3 (detectable):
`tests/invariants/module-dictionary-ssot.spec.ts` replaces the parity spec. It fails on any union
of module literals outside the dictionary, on Postgres labels that differ from it, and on drift in
auth `createDefaults`.

Pinned by. platform-modules.spec.ts and that invariant.

Rule broken. Repo single-source-of-truth rule (one declaration, everything else derived) and owner
decisions D3 and D4, which fix the owner modules as farm, hr, sensor and hydroponics, with
hydroponics reserved

Evidence:

```text
apps/auth-service/src/modules/system-module/entities/module.entity.ts:12-23 (six codes including alert and ai, kept in sync with MODULE_SCHEMAS by comment only)
apps/hr-service/src/common/enums.ts:32-36 (farm, hydroponics, sensor; no hr)
apps/alert-engine/src/alert/entities/alert-module.enum.ts:21-25 (farm, sensor, hydroponics; no hr)
libs/shared-contracts/src/ai/persona-catalogue.ts:49 (AiSpecialtyModule hand-typed as farm)
web/shell/src/console/nav/types.ts:36 (web union farm, hydroponics, sensor, hr)
web/modules/tenant-admin/src/pages/TenantDatabase.tsx:753 (literal farm, sensor, hr, other)
```

## RBAC-MEDIUM-024

Defect. The access vocabulary has no single owner: the role hierarchy is hand-copied into the web
as matching backend, the admin bypass and capability check are re-implemented in shared-ui, the
capability catalogue is private to auth-service, and the only module-access rule exists in the web
client.

Package PKG-02, release R1, severity MEDIUM.

Where. `libs/shared-contracts`, the one library both the backend and the web import, holds no
access vocabulary, so each surface typed its own. backend-common owns `Role` and `ROLE_HIERARCHY`.
shared-ui re-declares both behind a comment that promises parity, and declares `UserRole` three
times. `tenant-capabilities.ts` restates the SUPER_ADMIN/TENANT_ADMIN bypass of
`hasAllResourcePermissions`. The capability catalogue is a literal inside auth-service.

Root cause. No function answers 'may this caller read module m' on the server. The web answers it
in `roleHasModuleAccess` from `user.role` and the role-less `modules` list, and TENANT_ADMIN
always passes. Guards, NATS responders, sockets and the nav have nothing shared to agree on. A
change to one copy, such as a new role or a Company capability, silently diverges from the others.

Fix tier. 1 (impossible). `libs/shared-contracts/src/access/` holds the access kinds,
`decideAccess`, `ModuleScope`, the platform roles and the tenant capabilities.
`roles.decorator.ts` derives from it, and the web copies are deleted. 3 (detectable): a
table-driven `decide-access.spec.ts` over every viewer in plan section 2, `module-scope.spec.ts`
(narrowing never widens) and `tests/invariants/role-hierarchy-single-owner.spec.ts` with Role-enum
parity.

Rule broken. Plan section 2 and PKG-02: one pure decideAccess shared by guards, NATS, sockets and
the nav, in which the global role never grants module access; repo single-source-of-truth rule

Evidence:

```text
libs/backend-common/src/decorators/roles.decorator.ts:82-95 (backend ROLE_HIERARCHY and roleHasPermission)
web/shared-ui/src/contexts/AuthContext.tsx:210-220 (web copy of the hierarchy labelled matching backend)
web/shared-ui/src/contexts/AuthContext.tsx:222-232 (module access decided only in the web, TENANT_ADMIN always true)
web/shared-ui/src/utils/tenant-capabilities.ts:22-37 (admin bypass and capability membership re-implemented)
apps/auth-service/src/modules/tenant/services/permission-catalogue.ts:20-134 (catalogue literal no other workspace can import)
web/shared-ui/src/types/index.ts:18 (one of three web UserRole unions, beside AuthContext.tsx:37 and tenant-admin lib/types.ts:20)
```

## RBAC-HIGH-025

Defect. The tenant capability catalogue offers 82 of its 100 resource:action keys that no backend
check reads (every farm, batch and operations key, the HR employee, attendance, leave and shift
keys, reports, settings and most messaging keys), so a restriction a tenant admin sets in the role
editor restricts nothing.

Package PKG-03, release R1, severity HIGH.

Where. `permissionCategories` serves the whole PERMISSION_CATEGORIES literal to the tenant role
editor, and token mint stamps the granted keys into `resourcePermissions`. Only 18 keys are read
by any backend check: users:, roles:, hr_finance:view_salary, channels:create_group,
ai_assistant:use, ai_settings:, ai_personas: and ai_specialties:farm. farm-service checks no
tenant capability at all and decides `createBatch` from the global role
(`permission-matrix.ts:51`). admin-api also publishes its own list
(`role-template.service.ts:46-108`) with keys that neither the catalogue nor any guard knows.

Failure. A tenant admin builds a role without batches:create or employees:view. A MODULE_USER
holding that role still creates batches and lists employees.

Root cause. The catalogue was written as a product wish list, and TenantPermissionGuard is opt-in.
An unenforced key costs nothing to add, and nothing detects it.

Fix tier. 1+3. The catalogue keeps only enforced keys plus company:view. An idempotent admin-api
migration removes the inert keys from stored roles and logs per-tenant counts.
`tests/invariants/tenant-capability-usage.spec.ts` fails when a catalogue key has no enforcing
reader.

Pinned by. That invariant and a cleanup migration-harness spec.

Rule broken. Plan PKG-03 goal (the catalogue holds only enforced keys plus company:view) and the
repo hierarchy impossible &gt; detectable: a control offered to a tenant admin must be enforced or
must not exist

Evidence:

```text
apps/auth-service/src/modules/tenant/services/permission-catalogue.ts:21-59 (farm, batch and operations categories, none read by any guard)
apps/auth-service/src/modules/tenant/services/permission-catalogue.ts:60-80 (HR employee, attendance, leave, shift and reports keys; only hr_finance:view_salary is enforced)
libs/backend-common/src/guards/tenant-permission.guard.ts:73-76 (a capability binds only where a handler names it)
apps/farm-service/src/common/authz/permission-matrix.ts:51 (createBatch decided by global role alone; batches:create is never read)
apps/admin-api-service/src/users/services/role-template.service.ts:46-108 (a second published list with keys such as farms:view and users:create that the catalogue does not contain)
```

## RBAC-MEDIUM-026

Defect. edge:manage-io-config is enforced on six sensor-service I/O and digital-output mutations
but is absent from the capability catalogue, which rejects unknown keys on grant, so no
MODULE_MANAGER can ever hold it although @Roles admits the role.

Package PKG-03, release R1, severity MEDIUM.

Where. addDeviceIoConfig, updateDeviceIoConfig, removeDeviceIoConfig, pushIoConfigToDevice,
setDigitalOutput and bulkAddDeviceIoConfigs each require `@Roles(TENANT_ADMIN, MODULE_MANAGER)`
and `@RequireTenantPermission('edge:manage-io-config')`. SENSOR-HIGH-022 wired
TenantPermissionGuard globally, so the key is enforced. The key was never added to
PERMISSION_CATEGORIES, and CapabilityAuthorityService rejects any grant outside
CATALOGUE_CAPABILITIES. The MODULE_MANAGER entry in @Roles is therefore dead. Only TENANT_ADMIN
and SUPER_ADMIN, who bypass the check, can configure device I/O or drive a digital output. The
2026-10-02 ARIA program review parked this as 'ungrantable' without registering it
(`docs/reviews/claude/2026-10-02-aria-program-review.md:13`).

Root cause. Enforced keys and grantable keys live in two hand-maintained lists, string literals in
resolvers and the catalogue literal, and nothing ties them together.

Fix tier. 1 (impossible). The key is declared once in the catalogue as
`edge_devices:manage_io_config`, and the resolver imports that constant. 3 (detectable): the
tenant-capability-usage invariant fails when an enforced key is missing from the catalogue.

Pinned by. The resolver permission spec (updated key) and that invariant.

Rule broken. Plan PKG-03 (add edge_devices:manage_io_config; every enforced key must be grantable
through the catalogue) and the repo hierarchy impossible &gt; detectable

Evidence:

```text
apps/sensor-service/src/edge-device/edge-device.resolver.ts:351-352 (Roles TENANT_ADMIN, MODULE_MANAGER plus RequireTenantPermission edge:manage-io-config, repeated at 366, 381, 396, 421 and 472)
apps/sensor-service/src/app.module.ts:527-536 (TenantPermissionGuard registered globally, so the key is enforced)
apps/auth-service/src/modules/tenant/services/permission-catalogue.ts:20-134 (no edge resource in any category)
apps/auth-service/src/modules/tenant/services/capability-authority.ts:217-223 (unknown capabilities are rejected on grant)
libs/backend-common/src/decorators/require-permission.decorator.ts:87-91 (only SUPER_ADMIN and TENANT_ADMIN bypass)
```

## RBAC-HIGH-027

Defect. A module grant carries no role: user_module_assignments has no role column, the per-module
manager choice is stored only as isPrimaryManager which token mint never reads, and the JWT
carries the tenant-wide users.role plus a role-less list of module codes, so a manager of one
module is a manager of every module.

Package PKG-04, release R1, severity HIGH.

Where. auth-service models module access as `user_module_assignments(userId, moduleId,
isPrimaryManager, isActive, permissions)`. When a tenant admin assigns someone to a module as
manager, `tenant-admin.service.ts:361-368` stores `isPrimaryManager`. `getUserModules` maps each
row to `{code, name, defaultRoute}` and drops that flag. The access token carries `role` from
users.role and `modules` as bare codes.

Root cause chain. Without a per-module role, the only way to make someone a manager is the
tenant-wide users.role. Assign Manager does exactly that (`tenant.service.ts:582-586`, registered
under PKG-06). Every service then reads MODULE_MANAGER as manager of every module, and
`getUserAssignedSites` lifts that user's site restriction in all modules. A farm manager is
therefore also a sensor and hr manager, and D5's 'a module manager sees only their slice' cannot
be expressed.

Fix tier. 1 (impossible). Add a role column, nullable under C3. A counted backfill sets
MODULE_MANAGER from isPrimaryManager, managerId or, outside hr, the global role; hr gets it only
from isPrimaryManager. Every writer sets the role, and a module-access reader mints the per-module
role.

Pinned by. A reader spec (an hr grant is never derived from the global role) and a
migration-harness backfill spec on real Postgres with FORCE RLS.

Rule broken. Plan section 2 target model (claim moduleAccess maps each module to MODULE_MANAGER or
MODULE_USER; users.role becomes an account role only) and owner decisions D2 and D5

Evidence:

```text
apps/auth-service/src/modules/authentication/entities/user-module-assignment.entity.ts:62-83 (only isPrimaryManager and an unused permissions jsonb; no role column)
apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:361-368 (a per-module manager choice is stored as isPrimaryManager)
apps/auth-service/src/modules/authentication/services/token.service.ts:563-575 (assignments mapped to code, name and route; isPrimaryManager dropped)
apps/auth-service/src/modules/authentication/services/token.service.ts:370-377 (role and roles from users.role; modules a bare list of codes)
apps/auth-service/src/modules/authentication/services/token.service.ts:593-599 (users.role MODULE_MANAGER lifts the site restriction in every module)
libs/backend-common/src/decorators/roles.decorator.ts:36-42 (MODULE_MANAGER documented as manager of a single module, yet stored tenant-wide)
```

## RBAC-HIGH-028

Defect. Module grants never reach a decision point: the gateway copies the modules claim into a
TenantContext nothing reads, the HMAC-bound verified-user assertion and the rebuilt subgraph
req.user carry no module field, and the NATS caller-capability and AI chat contracts carry only
roles and resourcePermissions.

Package PKG-04, release R1, severity HIGH.

Where. The only backend reader of the JWT `modules` claim is `tenant-isolation.guard.ts:233`,
which copies it into `TenantContext`. No code reads `TenantContext.modules`. On the production
path, subgraphs rebuild `req.user` from the gateway assertion, whose input type has subject,
roles, assignedSiteIds, mobileFeatures, planLevel and resourcePermissions, but no module grant.
NATS callers resolve identity through `ResolveCallerCapabilitiesResult`, and AI chat through
`AiChatNatsRequest`. Neither has modules.

Root cause. Each claim was threaded through on its own (SEC-HIGH-051 assignedSiteIds, SEC-HIGH-052
mobileFeatures, MT-HIGH-054 resourcePermissions). Module grants were never one of them. Even a
correct grant could not be enforced by farm, hr, sensor, alert or ai, because it never arrives.

Fix tier. 1 (impossible). `moduleAccess` is always present in the assertion, inside the existing
assertion hash. An absent value means no grants, and a malformed value returns 400.
`ResolveCallerCapabilitiesResult` gains moduleAccess and assignedSiteIds, and the AI chat gateway
forwards them.

Pinned by. Middleware, data-source and proxy specs, plus the e2e header-spoofing cell (a forged
moduleAccess is rejected).

Rule broken. Plan section 2 and PKG-04: the per-module grant is carried, integrity-protected, to
every subgraph, the AI chat path and the messaging bridge; owner decision D2 cannot be enforced
without it

Evidence:

```text
apps/gateway-api/src/guards/tenant-isolation.guard.ts:233 (sole backend reader of the modules claim; copies it into TenantContext)
apps/gateway-api/src/federation/authenticated-data-source.ts:285-304 (assertion built from roles, assignedSiteIds and resourcePermissions only)
libs/backend-common/src/http/gateway-verified-user-assertion.ts:5-33 (assertion input has no module grants)
libs/backend-common/src/middleware/verified-user-assertion.middleware.ts:101-128 (subgraph req.user rebuilt without modules)
libs/event-contracts/src/auth-user-queries.ts:125-133 (ResolveCallerCapabilitiesResult carries roles and resourcePermissions only)
apps/ai-service/src/chat/ai-chat.responder.ts:29-40 (AI chat request carries userRoles and resourcePermissions only)
```

## RBAC-MEDIUM-029

Defect. Token mint builds a member's modules claim from active assignments without joining
tenant_modules.isEnabled or narrowing to owner modules, so a module removed from the tenant stays
in every member's claim on each refresh and alert or ai assignments appear as module grants.

Package PKG-04, release R1, severity MEDIUM.

Where. `getUserModules` has two branches. TENANT_ADMIN reads `tenant_modules` joined to `modules`
with `isEnabled = true`. Every other user reads `user_module_assignments` and keeps the rows where
`isAccessible()` holds, and that checks only `isActive` and `expiresAt`. `removeTenantModule` sets
`isEnabled = false` and touches no assignment.

Failure. A tenant drops the sensor module. Its admins lose sensor at the next refresh. Every
member assigned to sensor keeps 'sensor' in the claim indefinitely, and `roleHasModuleAccess`
keeps opening that workspace. A member with an alert or ai assignment receives those codes as
though they were owner-module grants, against D4.

Root cause. One method holds two readers of 'which modules may this user use', each with a
different predicate.

Fix tier. 1 (impossible). One module-access reader serves every kind of caller. It joins
`isEnabled`, narrows through `isOwnerModuleCode`, and counts the codes it drops.

Pinned by. Reader spec rows for a disabled module, an alert or ai row and an unknown code, and the
e2e cell 'disabled module: FORBIDDEN after refresh'.

Rule broken. Plan PKG-04 reader rule (codes narrowed through isOwnerModuleCode,
tenant_modules.isEnabled joined for every caller) and owner decision D4 (messaging, ai and alert
are not owner modules)

Evidence:

```text
apps/auth-service/src/modules/authentication/services/token.service.ts:547-553 (the TENANT_ADMIN branch joins tenant_modules.isEnabled)
apps/auth-service/src/modules/authentication/services/token.service.ts:563-575 (the member branch reads assignments with no tenant_modules join and no code narrowing)
apps/auth-service/src/modules/authentication/entities/user-module-assignment.entity.ts:134-138 (isAccessible checks only isActive and expiresAt)
apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts:527-533 (RemoveModule only flips tenant_modules.isEnabled)
apps/auth-service/src/modules/system-module/entities/module.entity.ts:16-23 (ModuleCode includes alert and ai)
web/shared-ui/src/contexts/AuthContext.tsx:222-232 (the web opens a module for any code in that list)
```

## RBAC-HIGH-030

Defect. The shared guard layer fails open for unclassified operations: RolesGuard admits any
authenticated caller when a handler declares no @Roles and TenantPermissionGuard passes without a
decorator, and only farm-service has a fail-closed operation classification, so unannotated hr and
sensor operations answer every tenant member.

Package PKG-05, release R1, severity HIGH.

Where. hr-service and sensor-service register RolesGuard and TenantPermissionGuard as APP_GUARDs.
RolesGuard returns true for any authenticated user when there is no @Roles metadata.
TenantPermissionGuard is opt-in. An operation without annotations is therefore open to every
member of the tenant. Live instances include teamLeaveCalendar and weeklyPlans in hr (registered
as HR-HIGH-056) and edgeDevice and edgeDevices in sensor. Field resolvers run no guards at all
(`department-fields.resolver.ts:12-15`). Only farm-service fails closed, through its own
PermissionMatrixGuard.

Root cause. The shared guard's default is 'authenticated is enough'. The classification that turns
a missing annotation into a denial exists in one service as a private matrix.

Fix tier. 1 (impossible). A backend-common access-classification guard denies unannotated root
fields, @ResolveReference handlers and REST handlers in enrolled services. Every enrolled
@ResolveField takes @AccessCaller() or is listed with a reason in PARENT_SCOPED_FIELDS. 3
(detectable): the module-access-classification and module-access-guard-adoption invariants plus
the metric `module_access_denied_total`. Each service's enrolment package (PKG-07, PKG-08, PKG-11,
PKG-12) closes its own instances, such as HR-HIGH-056.

Pinned by. A classification spec and roles.guard.access.spec.ts.

Rule broken. Plan PKG-05 goal (unclassified operations fail closed) and the repo hierarchy
impossible &gt; automatic &gt; detectable

Evidence:

```text
libs/backend-common/src/guards/roles.guard.ts:67-73 (no @Roles metadata: any authenticated user passes)
libs/backend-common/src/guards/tenant-permission.guard.ts:73-76 (no decorator: the guard passes)
apps/hr-service/src/app.module.ts:396-397 (RolesGuard is an hr APP_GUARD; sensor registers it the same way at app.module.ts:523-524)
apps/hr-service/src/leave/leave.resolver.ts:306 (teamLeaveCalendar declares no @Roles)
apps/sensor-service/src/edge-device/edge-device.resolver.ts:87 (edgeDevice query declares no @Roles, nor does its class)
apps/farm-service/src/app.module.ts:576-577 (farm's PermissionMatrixGuard is the only fail-closed classification)
```

## RBAC-HIGH-031

Defect. RolesGuard evaluates @Roles against the tenant-wide users.role only, so a requirement
written for one module is met by a manager or user of any other module, for example payrolls
admits a MODULE_MANAGER who manages only farm.

Package PKG-05, release R1, severity HIGH.

Where. `RolesGuard.canActivate` collects the caller's roles from `user.roles` and `user.role` and
checks them against `@Roles` through `ROLE_HIERARCHY`. Neither the metadata nor the guard names a
module.

Failure. A user made manager of farm holds users.role = MODULE_MANAGER and calls `payrolls`.
RolesGuard finds MODULE_MANAGER and admits the call. The same holds for every
`@Roles(MODULE_MANAGER)` or `@Roles(MODULE_USER)` operation in hr, sensor, alert-engine and
hydroponics, and for farm's role matrix. This finding is the shared mechanism. The concrete hr pay
exposure under D6 is registered with PKG-07.

Root cause. A role requirement carries no module, and the guard has no per-module input to compare
against. Every module collapses into one.

Fix tier. 1 (impossible). RolesGuard checks @Roles against the caller's role in the handler's
declared module and stores nothing on `req`, so sibling root fields of one request cannot share a
decision. `@AccessCaller()` recomputes decideAccess per handler and returns a branded
AccessCaller. Each service adopts it in its own enforcement package with its own finding.

Pinned by. roles.guard.access.spec.ts, an aliased-operation spec in which each root field sees
only its own scope, and the no-global-role-authz invariant.

Rule broken. Plan section 2 rule that the global role never grants module access, and owner
decisions D2 and D6

Evidence:

```text
libs/backend-common/src/guards/roles.guard.ts:80-88 (the decision input is the caller's global roles)
libs/backend-common/src/guards/roles.guard.ts:105-130 (roles read from user.roles and user.role; no module input)
libs/backend-common/src/decorators/roles.decorator.ts:82-95 (hierarchy defined over global roles only)
apps/hr-service/src/hr/hr.resolver.ts:209-211 (payrolls gated by Roles TENANT_ADMIN, MODULE_MANAGER)
apps/farm-service/src/common/authz/permission-matrix.ts:8-9 (farm's operation matrix maps operations to global roles only)
```

## FE-MEDIUM-380

Defect. An open console tab never learns that a new build is deployed: the shell has no build
identity check, the edge answers a previous build's missing chunks with index.html, and
GRAPHQL_VALIDATION_FAILED is thrown like any other error, so after a deploy the only recovery is a
manual reload.

Package PKG-42, release R1, severity MEDIUM.

Where. The shell image carries only its own hashed assets. A deploy replaces it. The shell's nginx
answers a missing `.js` with 404, and the edge turns that 404 into `index.html`. No code in
web/shell or shared-ui knows which build the tab runs. `web/shell/public/sw.js` only unregisters
an old worker. The API client throws GRAPHQL_VALIDATION_FAILED like any other error.

Failure. A user keeps the console open across a release and then opens a lazily loaded page. The
browser asks for a chunk of the old build, receives HTML, the module import fails, and
ErrorBoundary asks for a manual refresh. When a release removes or renames a GraphQL field
(BREAKING footer, for example the OwnerModule rename in R2), the old bundle's documents fail
validation at the router, and every page errors until the user reloads.

Root cause. The client does not know which build it is running, and the server never tells it.

Fix tier. 2 (automatic). A served build manifest plus `useBuildSkewReload`, which compares the
build id on focus, on navigation and on GRAPHQL_VALIDATION_FAILED and reloads when it changes.

Pinned by. A skew spec, plus the acceptance check that an open tab reloads after a deploy.

Rule broken. Contract rules C1 and C6 and the PKG-42 goal: a deploy or a BREAKING release never
strands an open client

Evidence:

```text
infrastructure/docker/nginx/shell.conf:51-56 (a missing hashed JS chunk returns 404 from the shell container)
infrastructure/nginx/droplet.conf:586-587 (the edge intercepts that 404 and serves index.html instead)
docker-compose.droplet.yml:1937 (the shell image is replaced per release tag, so the previous build's chunks are gone)
scripts/deploy/droplet-up.sh:1355 (every full deploy recreates the containers)
web/shared-ui/src/utils/api-client.ts:894-898 (a GRAPHQL_VALIDATION_FAILED response is thrown as an ordinary GraphQLClientError)
web/shared-ui/src/components/guards/ErrorBoundary.tsx:109-111 (the only recovery is a user-pressed reload)
```

## MOB-MEDIUM-031

Defect. aquamobil serves its encrypted offline cache on every request failure, including FORBIDDEN
and UNAUTHENTICATED, under a key of tenant plus domain key only, so a device keeps showing alarms,
tanks and readings after the server refuses the caller until the entry expires.

Package PKG-42, release R1, severity MEDIUM.

Where. `cacheData` and `getCachedData` key the encrypted IndexedDB cache as tenant plus domain
key. One durable device key encrypts every entry. The readers wrap the network call in a
catch-all: useAlerts, useTanks and useLatestReadings return the cached copy for any thrown error,
whether a network failure or the server's FORBIDDEN or UNAUTHENTICATED verdict. The cache is wiped
only on logout (`useAuth.tsx`, clearAllUserData).

Failure. A member's access to farm data is withdrawn by a role change, a disabled module or, from
R4, a revoked module grant. They keep seeing the cached tank list and readings until the entry's
TTL ends (one hour for tanks), because each refusal falls into the same catch block as an outage.

Root cause. The cache was designed as a fallback for network failures, but neither its key nor its
read path tells 'offline' apart from 'refused'.

Fix tier. 2 (automatic). The key becomes tenant + user + hash(moduleAccess). The cache is read
only on network errors. FORBIDDEN, UNAUTHENTICATED or a changed moduleAccess purges it.

Pinned by. Cache-key and purge specs, plus the acceptance check that a revoked mobile user sees no
cached farm data.

Rule broken. Plan PKG-42 goal and owner decision D2: a device never serves cached module-private
data after the server refuses the caller

Evidence:

```text
web/apps/aquamobil/src/pwa/offline-queue.ts:632 (entries keyed by tenant and domain key, with no user and no grants)
web/apps/aquamobil/src/pwa/offline-queue.ts:644-653 (lookup by tenant and key only)
web/apps/aquamobil/src/pwa/offline-queue.ts:96-110 (one durable device key encrypts every entry)
web/apps/aquamobil/src/hooks/useAlerts.ts:88-93 (any error returns cached alarms)
web/apps/aquamobil/src/hooks/useTanks.ts:226-232 (any error returns cached tanks)
web/apps/aquamobil/src/hooks/useLatestReadings.ts:139-145 (any error returns cached readings)
```

## RBAC-MEDIUM-032

Defect. The supergraph carries the module concept in three incompatible shapes: auth exposes
Module.code as a free String with lower-case values while hr-service exposes HRModuleCode and
alert-engine AlertModule as separate upper-case enums without hr, so every client maps between
them by hand.

Package PKG-01, release R2, severity MEDIUM.

Where. Auth publishes module identity as `Module.code: String` ('farm'). Its `ModuleCode` enum is
registered but no field uses it. hr-service publishes `HRModuleCode` and alert-engine publishes
`AlertModule`, two separate enums with the upper-case values FARM, HYDROPONICS and SENSOR. Web
codegen therefore holds two identical unions (`graphql-types.ts:380-384` and `7662-7665`), while
the nav types the same idea as lower-case `'farm' | ... | 'hr'`. Every caller converts between
them by hand.

Root cause. Each service registered its own TS enum with `registerEnumType` under a service-local
name, and federation composes them as unrelated types. Adding hr (D4) or reserving hydroponics
(D3) needs schema changes in several subgraphs plus two codegen regenerations, and any one of them
can be missed.

Fix tier. 1 (impossible). A single GraphQL `OwnerModule` is built from the dictionary in
`libs/backend-common/src/graphql/owner-module.enum.ts` and registered once. The old names retire
in a BREAKING release that carries no migrations (C6), with the web and aquamobil documents and
both codegen outputs regenerated together.

Pinned by. module-dictionary-ssot (the GraphQL enum equals the dictionary), codegen:check and
apollo-router:compose.

Rule broken. Repo single-source-of-truth rule applied to the wire contract, and owner decision D4:
one owner-module vocabulary for every subgraph and client

Evidence:

```text
apps/auth-service/src/modules/system-module/entities/module.entity.ts:44-49 (Module.code exposed as a free String with lower-case values)
apps/hr-service/src/common/enums.ts:38-41 (GraphQL enum HRModuleCode)
apps/alert-engine/src/alert/entities/alert-module.enum.ts:27-30 (GraphQL enum AlertModule)
apps/hr-service/src/hr/hr.resolver.ts:281 (hrDepartments filter typed HRModuleCode)
apps/alert-engine/src/alert/entities/alert-history.entity.ts:81-83 (AlertHistory.module typed AlertModule)
web/shared-ui/src/generated/graphql-types.ts:7662-7665 (HrModuleCode union, identical to the AlertModule union at lines 380-384)
```

## RBAC-MEDIUM-033

Defect. The tenant role editor saves capabilities under display names: permissionCategories drops
the resource key, PermissionCheckboxGroup keys the panel by resource.name, and the server turns
that into strings such as HR Finance:view_salary, which the catalogue whitelist rejects.

Package PKG-03, release R2, severity MEDIUM.

Where. The resolver iterates `Object.entries(category.resources)`, discards the key and returns
only `name` and `actions`. `PermissionResource` has no key field. The editor then records each
tick under `resource.name`.

Failure. An admin ticks HR Finance / View Salary and saves. The panel arrives as `{hr: {'HR
Finance': {view_salary: true}}}`, `panelPermissionsToResourceArray` emits `HR
Finance:view_salary`, and `assertKnownCapabilities` answers BadRequest. A role stored with
key-shaped panels (sites, hr_finance) opens with every box unticked, because the editor looks
values up by display name. `formatResourceName` splits on underscores, which shows the component
was written to receive keys. Delegated capabilities (users:view, roles:, channels:create_group,
hr_finance:view_salary) cannot be granted through the UI, and members fail closed.

Root cause. The GraphQL type gives the client nothing but a label to send.

Fix tier. 1 (impossible). `PermissionResource` gains `key` additively in R1 (C1). The web stores
and sends keys in R2, so a label can never reach the wire.

Pinned by. A resolver key spec, a checkbox spec and e2e permission-propagation, which asserts that
a capability saved in the editor lands in the JWT.

Rule broken. Plan PKG-03 goal (the role editor stores keys, not display names) and the catalogue
contract that the wire form of a capability is resource-key:action

Evidence:

```text
apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts:143-146 (resource key discarded; only display name and actions returned)
apps/auth-service/src/modules/tenant/dto/tenant-role.dto.ts:27-34 (PermissionResource has no key field)
web/modules/tenant-admin/src/components/permissions/PermissionCheckboxGroup.tsx:210 (a tick is recorded under resource.name)
web/modules/tenant-admin/src/components/permissions/PermissionCheckboxGroup.tsx:429-433 (select-all writes display-name keys)
apps/auth-service/src/modules/tenant/services/permission-catalogue.ts:145-159 (wire capability built as panel key plus action)
apps/auth-service/src/modules/tenant/services/capability-authority.ts:217-223 (any string outside the catalogue is rejected)
```

## RBAC-HIGH-034

Defect. Assign Manager promotes the chosen user's users.role to MODULE_MANAGER tenant-wide and
Remove Manager never reverts it, so naming someone manager of one module grants manager rights in
every module, HR payroll included.

Package PKG-06, release R3, severity HIGH.

Where. `TenantService.assignModuleManager` in auth-service is the only Assign Manager path
(AssignManagerModal → useAssignModuleManager). After setting `tenant_modules.managerId` it writes
`users.role = MODULE_MANAGER` (lines 582-586); `removeModuleManager` clears `managerId` and leaves
the role. The invite path (user-lifecycle.service.ts:897-950) and `assignUserToModule` (:299) also
store a module role as the account role.

Root cause. No per-module role exists, so the designation is folded into the single tenant-wide
`users.role`. Every enforcement point decides by that role (RolesGuard, HR payroll, the farm site
bypass), so naming someone farm manager also opens HR payroll and every other manager gate, and
the promotion is a one-way ratchet.

Fix tier 1 (impossible). PKG-06 deletes lines 582-586, Assign Manager writes a module grant
through `setUserModuleAccess`, and new `users.role` writes are typed as `AccountRole`. Users
already promoted are demoted by PKG-46 in R6.

Pinned by the assign-manager spec asserting `users.role` is unchanged after assignment, and the
acceptance cell "Assign Manager leaves users.role unchanged".

Rule broken. Plan §2 and the PKG-02 decision rule: users.role is an account role only and the
global role never grants module access (D6 pay stays inside HR).

Evidence:

```text
apps/auth-service/src/modules/tenant/services/tenant.service.ts:582-586 (assignModuleManager overwrites users.role with Role.MODULE_MANAGER for any non-admin)
apps/auth-service/src/modules/tenant/services/tenant.service.ts:609 (removeModuleManager only nulls managerId; the promoted role stays)
apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:299 (assignUserToModule maps a per-module 'manager' to the global Role.MODULE_MANAGER)
apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:897-900 (invites accept any canonical role, module roles included, written as the account role at :950)
apps/hr-service/src/hr/hr.resolver.ts:209-211 (payrolls admits any global MODULE_MANAGER)
```

## RBAC-HIGH-035

Defect. Module-access removal revokes no session and writes no audit row: RemoveModule only flips
tenant_modules.isEnabled and removeUserFromModule and removeModuleManager only update rows, so
live access tokens keep the module until expiry, while site-assignment changes already enqueue a
durable token invalidation.

Package PKG-06, release R3, severity HIGH.

Where. auth-service has three module-access removal paths: the governed `RemoveModule` command
(tenant-provisioning-command.service.ts:515-542), `removeUserFromModule`
(tenant-admin.service.ts:386-417) and `removeModuleManager` (tenant.service.ts:596-615). Each
updates one row and returns. Assign Manager likewise records only a log line.

Root cause. Module access was never modelled as an authorization grant, so its writers were not
wired to the token-invalidation and audit machinery that site assignments
(tenant-admin.service.ts:566-581) and tenant suspension
(tenant-provisioning-command.service.ts:970-972) already use. A removed user keeps the module in
every live access token. The socket revalidator checks only the blacklist and user epoch, so their
sockets stay open too. Filtering disabled modules out of newly minted tokens is the PKG-04 reader
change.

Fix tier 2 (automatic). `setUserModuleAccess` and `RemoveModule` invalidate the affected tokens,
write the audit row and enqueue the capability-cache eviction in the same transaction as the grant
change, so no grant write can skip them.

Pinned by the revocation-on-module-removal and set-access specs, and the §7 timing cell (FORBIDDEN
within one access-token TTL, sockets dropped within 60 s).

Rule broken. The RBAC-HIGH-001 rule recorded at tenant-user-management.service.ts:140-145 (a
change to effective permissions must revoke live tokens) and the plan §7 timing cell (FORBIDDEN
within one access-token TTL after revocation).

Evidence:

```text
apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts:525-536 (RemoveModule only sets isEnabled=false)
apps/auth-service/src/modules/tenant/services/tenant-provisioning-command.service.ts:970-972 (the suspend path in the same service revokes user tokens; RemoveModule does not)
apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:412-413 (removeUserFromModule flips isActive with no invalidation and no audit)
apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:574-581 (site-assignment changes enqueue a durable token invalidation, the pattern module changes skip)
apps/auth-service/src/modules/tenant/services/tenant.service.ts:588 (Assign Manager records only a log line, no audit row)
```

## RBAC-MEDIUM-036

Defect. The module manager is stored twice and the copies never meet: Assign Manager writes only
tenant_modules.managerId, which no token or access decision reads, while tokens and invites use
user_module_assignments; the assignment permissions JSON and the
assignUserToModule/removeUserFromModule mutations have no reader or caller.

Package PKG-06, release R3, severity MEDIUM.

Where. auth-service records the module manager in `tenant_modules.managerId` (written only by
Assign Manager, tenant.service.ts:578-580) and in `user_module_assignments.isPrimaryManager`
(written by invites and `assignUserToModule`). Neither writer touches the other. The token reader
(token.service.ts:563-574) sees only assignments. A user named manager in the console can
therefore carry no claim for that module while the console lists them as its manager.

Root cause. Two admin generations were never converged. The older assignment mutations stayed on
the schema with no client. The `permissions` JSON was mapped and exposed but never read. The newer
modal wrote a separate column.

Fix tier 1 (impossible). PKG-06 routes Assign Manager through `setUserModuleAccess`, unmaps
`managerId` and `permissions` (C4 orphans, dropped by PKG-40 in R13), and deletes both unused
mutations with a BREAKING footer, so the assignment row is the only record of a module role.

Pinned by the assign-manager spec (an assignment row with MODULE_MANAGER exists after assignment)
and codegen:check, which fails while any document still selects the removed fields.

Rule broken. Repo SSOT rule (one owner per fact) and plan §2: the per-module role lives only in
user_module_assignments and is the only source of the moduleAccess claim.

Evidence:

```text
apps/auth-service/src/modules/tenant/services/tenant.service.ts:578-580 (Assign Manager writes managerId only and creates no user_module_assignments row)
apps/auth-service/src/modules/tenant/entities/tenant-module.entity.ts:102-108 (managerId mapped and exposed on GraphQL; only tenant.service.ts:579 and :609 touch it)
apps/auth-service/src/modules/authentication/services/token.service.ts:563-574 (the modules claim is built from assignments only, so a designated manager without an assignment row gets no claim for the module)
apps/auth-service/src/modules/authentication/entities/user-module-assignment.entity.ts:81-83 (permissions JSON exposed on GraphQL; its only reader hasPermission at :148-151 has no caller)
apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts:114-138 (assignUserToModule and removeUserFromModule; no operation in web, aquamobil or e2e calls them)
```

## HR-CRITICAL-065

Defect. hr-service gates payroll, HR finance and payroll cost settings on the global
MODULE_MANAGER role alone, so a farm or sensor manager lists every payroll with base salary and
gross pay, approves payroll and edits HR finance entries without holding any hr grant.

Package PKG-07, release R4, severity CRITICAL.

Where. HRResolver payroll operations (hr.resolver.ts:209-271) and HrFinanceResolver
(hr-finance.resolver.ts:106-257) carry `@Roles(TENANT_ADMIN, MODULE_MANAGER)`. hr-service
registers ServiceIdentity, Tenant, Roles and TenantPermission guards (app.module.ts:381-409). None
of them reads a module grant, and hr-service never reads the `modules` claim.

Root cause. The guards know only the tenant-wide `users.role`. Because Assign Manager writes that
role for any module (PKG-06 finding), a farm or sensor manager satisfies every manager-gated HR
operation. `payrolls` returns base salary and gross pay without even the `hr_finance:view_salary`
capability that `hrLabourCost` alone requires. `approvePayroll` and the finance writes sit behind
the same gate.

Fix tier 1 (impossible). PKG-07 registers the module access guard, drops the method-level
RolesGuard, and marks payroll, HR finance, labour cost (which keeps view_salary), dashboard stats
and analytics `Access.module('hr')`. No handler is then reachable without an hr grant.

Pinned by the HR finance and payroll access specs (roles A and A′ get FORBIDDEN),
`tests/invariants/hr-finance-module-boundary.spec.ts`, and the D6 cells of the §7 access matrix
(only hr grants reach pay).

Rule broken. D6: salary and HR finance are visible only inside HR, that is only to holders of an
hr grant.

Evidence:

```text
apps/hr-service/src/hr/hr.resolver.ts:209-223 (payrolls: @Roles TENANT_ADMIN, MODULE_MANAGER; no hr grant and no hr_finance:view_salary)
apps/hr-service/src/hr/hr.resolver.ts:258-262 (approvePayroll behind the same global-role gate)
apps/hr-service/src/hr/entities/payroll.entity.ts:159-161 (Payroll exposes earningsBaseSalary on GraphQL)
apps/hr-service/src/finance/resolvers/hr-finance.resolver.ts:167-169 (hrFinanceEntries; every finance read and write through :257 admits any MODULE_MANAGER)
apps/hr-service/src/finance/resolvers/hr-finance.resolver.ts:118-121 (only hrLabourCost also demands hr_finance:view_salary)
libs/backend-common/src/guards/roles.guard.ts:155-171 (RolesGuard, the only role decision hr registers at app.module.ts:394-399, matches global roles through the hierarchy)
```

## HR-HIGH-066

Defect. hr-service never derives a workforce scope from the caller: list reads are scoped only
when the client sends moduleCode, and reads by id or employeeId (employee, employeeCertifications,
performanceReviews) return any employee of the tenant to any caller who passes the role gate.

Package PKG-07, release R4, severity HIGH.

Where. hr-service scoping lives in `common/module-scope.ts`. Its contract (line 15) is that an
absent module means every module. The module comes from client arguments
(`EmployeeFilterInput.moduleCode`, `todaysAttendance(moduleCode)`). By-id and employeeId-keyed
reads (`GetEmployeeHandler`, `employeeCertifications`, `performanceReviews`) apply no scope at
all.

Root cause. Scope was built as a UI filter for the Company and module views, not as an
authorization result, so the caller's grants never enter the query. A farm MODULE_USER can request
`employee(id)` for a sensor-only employee, and a sensor manager can list every performance review
in the tenant. The leave, scheduling, training and performance operations that lack any @Roles
gate are the open HR-HIGH-056. That finding is linked here rather than duplicated.

Fix tier 1 (impossible). PKG-07 marks every read `scoped('workforce')`. Handlers require a
`ModuleScope` derived from `AccessCaller`, by-id and employeeId-keyed reads go through the new
`assertEmployeeInScope`, and `moduleCode` only narrows (ScopeWideningError returns FORBIDDEN).

Pinned by the spec in which role A reading `employee(id)` of a sensor-only employee gets
FORBIDDEN, the PKG-02 narrowing spec, and the by-id and by-employeeId rows of the §7 access
matrix.

Rule broken. D5 (a module manager sees only their slice) and contract rule C2 (module arguments
only narrow a scope the server derives).

Evidence:

```text
apps/hr-service/src/common/module-scope.ts:15 (an absent module means no scope: the Company view, every module)
apps/hr-service/src/hr/dto/employee-filter.input.ts:24-30 (moduleCode is an optional client filter, the only scope employees gets)
apps/hr-service/src/hr/query-handlers/get-employees.handler.ts:30-32 (the scope is applied only when the client sent moduleCode)
apps/hr-service/src/hr/query-handlers/get-employee.handler.ts:19-21 (employee(id) loads any employee of the tenant)
apps/hr-service/src/training/training.resolver.ts:143-151 (employeeCertifications(employeeId): no role gate and no scope)
apps/hr-service/src/performance/performance.resolver.ts:111-123 (performanceReviews: any employeeId, tenant-wide)
```

## HR-HIGH-067

Defect. hr-service decides contact-PII visibility and attendance management from the global
MODULE_MANAGER role, so a manager of any module reads unmasked home addresses and personal and
emergency phones of every employee in the tenant and manages attendance outside their module.

Package PKG-07, release R4, severity HIGH.

Where. `HRResolver.canViewEmployeeContactPii` (hr.resolver.ts:83-93) and
`AttendanceResolver.hasManagementRole` (attendance.resolver.ts:123-129) read `req.user.roles`, the
tenant-wide account role. They use it to decide who sees full contact PII and who manages
attendance.

Root cause. The DB-PEOPLE-MEDIUM-001 fix masked PII for MODULE_USER callers but chose the global
MODULE_MANAGER as the privileged tier, because no per-module role existed. Assign Manager writes
that role for any module. A sensor manager therefore receives unmasked home addresses, personal
phones and emergency contacts of the farm and HR workforce through `employees` and `employee`, and
is treated as an attendance manager for every module.

Fix tier 1 (impossible). PKG-07 makes the PII and attendance-management decisions read
`AccessCaller.effectiveRoles`. PKG-05 derives these from module grants and never from
`users.role`, so a global role cannot reach the privileged tier.

Pinned by the spec in which A′ (a farm manager who also holds the legacy global MODULE_MANAGER)
sees the redacted directory, and the D6 cell of the §7 access matrix (A′ sees redacted PII).

Rule broken. The PKG-02 decision rule (the global role never grants module access) and D5 (a
module manager sees only their slice).

Evidence:

```text
apps/hr-service/src/hr/hr.resolver.ts:83-86 (HR_PII_PRIVILEGED_ROLES lists the global MODULE_MANAGER)
apps/hr-service/src/hr/hr.resolver.ts:88-93 (any viewer holding that role sees full contact PII of any employee)
apps/hr-service/src/hr/hr.resolver.ts:150-154 (employees leaves the whole tenant list unmasked for such a viewer)
apps/hr-service/src/attendance/attendance.resolver.ts:127-129 (hasManagementRole is global TENANT_ADMIN or MODULE_MANAGER)
apps/hr-service/src/attendance/attendance.resolver.ts:306-309 (a global manager receives the tenant's attendance; moduleCode is optional)
```

## SEC-MEDIUM-205

Defect. The shared AuditLogInterceptor redacts arguments only by a fixed key-name list, so the
audited createEmployee, updateEmployee and createPayroll mutations store base salary, IBAN and
bank details and national ID verbatim in hr-service audit metadata.

Package PKG-07, release R4, severity MEDIUM.

Where. `AuditLogInterceptor` (libs/backend-common) serialises the GraphQL args of every
`@AuditLog` handler into `metadata.args` after `sanitizeObject`, which redacts only keys in
`SENSITIVE_KEYS`. hr-service registers it globally. `createEmployee`, `updateEmployee` (a partial
of the same input) and `createPayroll` are decorated. Their inputs carry `baseSalary`,
`bankDetails.iban` and `nationalId`, which are persisted unredacted.

Root cause. Sensitivity is inferred from a key-name denylist instead of being declared by the
field's owner. The list knows nothing of HR fields, and its matching is broken: line 429
lower-cases the key while `accessToken`, `refreshToken` and `creditCard` are stored camelCase, so
those three never match either.

Fix tier 1 (impossible). PKG-07 marks salary, identity and bank inputs with a typed
`@SensitiveAuditField`, and the interceptor redacts by that metadata. Declaring a field sensitive
is then what redacts it.

Pinned by the PKG-07 audit redaction spec over createEmployee, updateEmployee and createPayroll
payloads, extended to the three camelCase keys.

Rule broken. D6 (salary visible only inside HR) and the interceptor's own contract that sensitive
values never reach the audit trail.

Evidence:

```text
libs/backend-common/src/audit/audit-log.interceptor.ts:31-42 (SENSITIVE_KEYS has no salary, iban, bank or nationalId key)
libs/backend-common/src/audit/audit-log.interceptor.ts:429 (the lower-cased key is matched against camelCase entries, so accessToken, refreshToken and creditCard never match)
libs/backend-common/src/audit/audit-log.interceptor.ts:220-227 (all other GraphQL args are stored as metadata.args)
apps/hr-service/src/app.module.ts:410-414 (the interceptor is registered globally in hr-service)
apps/hr-service/src/hr/hr.resolver.ts:161 (createEmployee is @AuditLog-decorated)
apps/hr-service/src/hr/dto/create-employee.input.ts:174 (nationalId; baseSalary at :210 and bankDetails with iban at :223 sit on the same audited input)
```

## FARM-CRITICAL-466

Defect. farm-service authorizes every resolver by the global role alone, so any tenant member of
any module reads farm-private batches, tanks, feeds, water quality and storage, and any global
MODULE_MANAGER also reads financeLedger and regulatorySettings.

Package PKG-08, release R4, severity CRITICAL.

Where. farm-service registers ServiceIdentity, Tenant, Roles, Throttler and PermissionMatrix
guards (app.module.ts:530-578). Every farm root operation carries an @Roles list over
TENANT_ADMIN, MODULE_MANAGER and MODULE_USER, mirrored in permission-matrix.ts.

Root cause. Module membership was only ever a nav concern. The gateway copies the `modules` claim
into its tenant context (tenant-isolation.guard.ts:233) and no service decides on it. RolesGuard
compares tenant-wide roles. An HR clerk or sensor operator holding MODULE_USER therefore reads all
farm production data, and a sensor manager reads the farm finance ledger and regulatory settings.
The site layer narrows a MODULE_USER to assigned sites but never asks which module the user
belongs to.

Fix tier 1 (impossible). PKG-08 PR2 puts class-level `Access.module('farm')` on every farm
resolver and on the batch, marine-data and sentinel controllers, enforced by the PKG-05 guard. A
caller without a farm grant then cannot reach a handler.

Pinned by the §7 D2 cells (role B gets FORBIDDEN on batches, tanks, feeds, water quality, storage,
regulatorySettings, financeLedger and sites, and is denied on \_entities) and the
module-access-classification and module-access-guard-adoption invariants with farm-service
enrolled.

Rule broken. D2: module-private data is reachable only with that module's grant, and Company and
other modules never reach it through the UI or the API.

Evidence:

```text
apps/farm-service/src/app.module.ts:549-554 (RolesGuard is the only role decision; no guard reads a module grant)
libs/backend-common/src/guards/roles.guard.ts:155-171 (RolesGuard matches tenant-wide roles through the hierarchy)
apps/farm-service/src/batch/resolvers/batch.resolver.ts:189-190 (batches admits TENANT_ADMIN, MODULE_MANAGER and MODULE_USER)
apps/farm-service/src/common/authz/permission-matrix.ts:511 (tanks, like feeds :386, storageInventory :487 and waterQualityMeasurements :529, open to every MODULE_USER)
apps/farm-service/src/common/authz/permission-matrix.ts:391 (financeLedger, like regulatorySettings :465, open to every global MODULE_MANAGER)
apps/gateway-api/src/guards/tenant-isolation.guard.ts:233 (the JWT modules claim is only copied into context, never decided on)
```

## FARM-LOW-468

Defect. farm-service keeps a hand-maintained second copy of every operation's @Roles list in
permission-matrix.ts, which PermissionMatrixGuard enforces only as a name-membership check and a
spec keeps equal to the decorators, so farm operation classification has two owners.

Package PKG-08, release R4, severity LOW.

Where. `permission-matrix.ts` restates the role list of every farm @Query and @Mutation.
`PermissionMatrixGuard`, a global APP_GUARD (app.module.ts:575-578), rejects only names missing
from it. `permission-matrix.spec.ts` asserts each entry equals its source decorator.

Root cause. The matrix was the phase-6.1 inventory used to drain grandfathered operations. The
drain finished (UNGATED_OPERATIONS is empty), but the copy stayed as a parallel classification.
Every new or changed farm operation is edited in two places, and the runtime guard decides nothing
the decorators do not already decide. It classifies by global role only, so it cannot carry a
module decision.

Fix tier 1 (impossible). PKG-08 PR2 deletes permission-matrix.ts, its guard and their specs. It
moves the UNGATED_OPERATIONS concept into the classification invariant and reuses
resolver-scanner.ts, so the PKG-05 access decorators and classification guard are the single
owner.

Pinned by the `module-access-classification` invariant, which denies any unannotated farm root
field, @ResolveReference handler or REST handler.

Rule broken. Repo SSOT rule (one owner per fact) and the ADR 051 enforcement order: classification
lives in the access decorators and a single classification guard.

Evidence:

```text
apps/farm-service/src/common/authz/permission-matrix.ts:8 (MUTATION_ROLES; QUERY_ROLES at :293; 659 lines in total)
apps/farm-service/src/common/authz/permission-matrix.guard.ts:19-24 (role sets are not checked at run time)
apps/farm-service/src/common/authz/permission-matrix.guard.ts:87-94 (the runtime check is name membership only)
apps/farm-service/src/common/authz/permission-matrix.ts:562-645 (UNGATED_OPERATIONS is empty)
apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts:98-150 (specs keep the copy equal to the @Roles decorators)
```

## FARM-MEDIUM-467

Defect. Site labels for other modules have no module-neutral contract: sensor, HR, dashboard,
console and tenant-admin surfaces read farm-service registry queries (sites, activeSites,
activeSiteAccessCatalog) directly and receive farm attributes where they need only labels.

Package PKG-08, release R4, severity MEDIUM.

Where. Five web surfaces outside the farm module query farm-service registry root fields through
the gateway: the sensor location hierarchy, HR site responsibility, the dashboard, the console
shell and tenant-admin site access. They need an id, code and name to label their own rows.

Root cause. The site registry has one read surface, owned by farm-service and open to every role.
Placement labels for other modules were never separated from the farm registry read. Those
surfaces therefore receive farm attributes (type, status, contacts) and break as soon as the
registry requires a farm grant. The aquamobil callers named in the plan were not re-verified here.

Fix tier 1 (impossible) plus tier 3. PKG-08 PR1 (R3) adds `request.farm.resolveSiteLabels` (at
most 200 ids, returns id, code, name and moduleCode, exact-key guards). It also adds
`placementSites` on sensor-service and hr-service, limited to ids their own rows reference (open
decision 3). PR2 (R4) switches every caller listed here in the same PR that gates the registry.

Pinned by the labels spec and the acceptance cell in which a sensor-only member still sees
placement labels while role B is FORBIDDEN on `sites`.

Rule broken. D2 and the open decision 3 default: other modules read farm site labels only, through
a module-neutral contract, never through farm-private registry reads.

Evidence:

```text
web/modules/sensor-module/src/hooks/useLocationHierarchy.ts:52-60 (sensor reads farm sites with type and status)
web/modules/hr-module/src/graphql/site-responsibility.operations.ts:18-27 (HR reads farm activeSites with contacts)
web/modules/dashboard/src/hooks/dashboard.operations.ts:86-95 (dashboard reads farm activeSites)
web/shell/src/console/data/console.operations.ts:55-61 (the console shell reads farm activeSites)
web/modules/tenant-admin/src/lib/api.ts:365-369 (tenant-admin reads farm activeSiteAccessCatalog)
apps/farm-service/src/common/authz/permission-matrix.ts:473 (sites is open to every role, which these callers rely on)
```

## RBAC-HIGH-037

Defect. Object-level site authorization grants tenant-wide site scope to any holder of the global
MODULE_MANAGER role, so a sensor or HR manager bypasses farm site restrictions in
SiteAuthorizationService, assertSelfOrManager and four inline checks in farm water-quality and
feeding code.

Package PKG-08, release R4, severity HIGH.

Where. `SiteAuthorizationService` and `assertSelfOrManager` in libs/backend-common are the site
and self-scope SSoT for farm-service (37 call sites). Four farm files repeat the same
`roleHasPermission(role, MODULE_MANAGER)` test inline.

Root cause. `SiteScopeCaller` carries only global `roles`, so the manager bypass asks whether the
caller manages anything at all. A sensor or HR manager holds the global MODULE_MANAGER role. On
any farm read or write the site layer returns TENANT scope, and they reach every site's batches,
water quality and feeding plans. Explicit site assignments exist only for MODULE_USER
(tenant-admin.service.ts:480-484), so an admin cannot restrict such a user to a farm site either.

Fix tier 1 (impossible). PKG-08 PR2 makes `SiteAuthorizationService` accept only a branded
`AccessCaller` and takes the manager bypass from the module of the current decision instead of a
fixed module. It moves the inline checks to the module role, so a global role cannot widen a site
scope.

Pinned by the site-scope spec for A′ assigned to S1 and the `no-global-role-authz` invariant with
farm-service enrolled.

Rule broken. The plan's decided default (a site assignment is a physical restriction in every
module where the user is MODULE_USER) and the PKG-02 rule that the global role never grants module
access.

Evidence:

```text
libs/backend-common/src/security/site-authorization.service.ts:67-73 (resolveSiteScope returns TENANT for any role at or above MODULE_MANAGER)
libs/backend-common/src/security/assert-self-scope.ts:62-67 (the owner-or-manager bypass uses the same global-role test)
apps/farm-service/src/water-quality/water-quality.service.ts:240-243 (assertUnitsSiteAuthorized skips site checks for a global manager)
apps/farm-service/src/water-quality/services/measurement-point-lookup.ts:127-130 (readsEverySite is decided from the global role)
apps/farm-service/src/feeding-protocol/resolvers/meal-execution.resolver.ts:81-83 (the day-plan read widens on the global role)
apps/farm-service/src/feeding-protocol/resolvers/feed-forecast.resolver.ts:76-78 (the forecast read widens on the global role)
```

## SEC-CRITICAL-206

Defect. The /farms Socket.IO gateway admits any token carrying a tenantId and emits all 41 farm
domain events (batches, mortality, feeding, meals, stock, sites, tanks) to one tenant-wide room,
so every connected tenant member receives farm-private data whatever their module.

Package PKG-10, release R4, severity CRITICAL.

Where. `FarmGateway` (namespace /farms) is fed by `FarmNatsBridgeService`, which forwards 41 farm
domain events per tenant as whole event objects. On connect the gateway verifies the JWT, keeps
only tenantId and sub, and joins the socket to `tenant:{tenantId}`. `emitFarmEvent` sends every
event to that room.

Root cause. Socket authorization was designed for tenant isolation only. Rooms are keyed by
tenant, and the handshake ignores roles, module grants and site assignments. Any tenant member (an
HR clerk, for example) who opens /farms with their own token receives mortality, feeding, meal,
batch and stock events live, outside every GraphQL gate PKG-08 adds. `WsTokenRevalidator`
re-checks only revocation, so it cannot drop a socket that lost access.

Fix tier 1 (impossible). PKG-10 adds a typed map from each farm event to its AccessSpec (new
farm-ws-event-access.ts) and rooms `t:{tenant}:m:{module}[:site:{id}]` and
`t:{tenant}:registry:{module}`. A socket joins only the rooms decideAccess allows, and the
revalidator disconnects sockets whose access was revoked.

Pinned by room specs for roles A, B and the S1 operator, and
`tests/invariants/ws-module-scoped-rooms.spec.ts`, which scans every @WebSocketGateway and every
socket path nginx routes.

Rule broken. D2: farm-private data reaches only holders of a farm grant, on every surface
including realtime pushes.

Evidence:

```text
apps/gateway-api/src/websocket/farm.gateway.ts:143-149 (the handshake requires only a token carrying tenantId)
apps/gateway-api/src/websocket/farm.gateway.ts:183 (every socket joins tenant:{tenantId})
apps/gateway-api/src/websocket/farm.gateway.ts:232 (every farm event is emitted to that room)
apps/gateway-api/src/websocket/farm-nats-bridge.service.ts:378-386 (MortalityRecorded and FeedingRecorded are forwarded as whole events)
apps/gateway-api/src/websocket/websocket.module.ts:55-56 (socket revalidation checks only the token blacklist and user epoch, never access)
```

## SEC-CRITICAL-207

Defect. The /sensors and /st-language Socket.IO gateways authorize by tenant alone: any tenant
member can stream live readings and edge I/O of every tenant sensor and device and call the
sensor-service ST language service without holding a sensor grant.

Package PKG-10, release R4, severity CRITICAL.

Where. `SensorReadingsGateway` (/sensors) authorizes subscriptions with `isSensorOwnedByTenant`
and `DeviceOwnershipService.verifyOwnership`, both tenant checks. When the token has no sensorIds
claim, it authorizes every tenant sensor at connect. `STLanguageGateway` (/st-language) accepts
any tenant token and forwards `st:request` to sensor-service with only `x-tenant-id`. Its
`pushToTenant` (:336-338) sends automation pushes to every tenant socket.

Root cause. As on /farms, socket authorization stops at the tenant and no caller grant crosses the
bridge. A farm operator or HR clerk can stream any sensor's readings and edge I/O tags, and can
call the sensor-service ST language service under the tenant's identity. Sensor rooms also lack
the tenant prefix other rooms carry. Whether the automation pushes flow today depends on the open
SENSOR-MEDIUM-189. The readings, edge I/O and request paths are live.

Fix tier 1 (impossible). PKG-10 requires a sensor grant at both handshakes and on each
subscription, and prefixes sensor rooms with the tenant. The ownership helper returns siteId so
site-bound users join only their sites, and WsTokenRevalidator drops sockets whose access was
revoked.

Pinned by room specs for A, B and the S1 operator, and `ws-module-scoped-rooms.spec.ts`.

Rule broken. D2: sensor-private data (readings, devices, edge I/O, PLC/SCADA programs) reaches
only holders of a sensor grant.

Evidence:

```text
apps/gateway-api/src/websocket/sensor-readings.gateway.ts:154-159 (without a sensorIds claim every tenant sensor is authorized at connect)
apps/gateway-api/src/websocket/sensor-readings.gateway.ts:255-258 (subscribe checks only tenant ownership of the sensor)
apps/gateway-api/src/websocket/sensor-readings.gateway.ts:283 (rooms sensor:{id} carry no tenant prefix; readings are emitted there at :395)
apps/gateway-api/src/websocket/sensor-readings.gateway.ts:330-342 (edge I/O rooms are joined on tenant ownership of the device only)
apps/gateway-api/src/websocket/st-language.gateway.ts:160-166 (the ST handshake checks only tenantId, then joins tenant:{tenantId} at :202)
apps/gateway-api/src/websocket/st-language-bridge.service.ts:150-155 (ST requests reach sensor-service with only the tenant header)
```

## SEC-HIGH-208

Defect. gateway-api upload and delete handlers for chemical and batch documents check only
authentication and tenant, so any tenant member of any module can attach files to, or delete
regulatory documents (MSDS, health certificates) from, any farm chemical or batch.

Package PKG-43, release R4, severity HIGH.

Where. `UploadController` (/api/upload) hosts POST and DELETE for chemical and batch documents.
Each handler reads `req.user`, takes `tenantId`, validates the file and writes or deletes
`{tenant}/chemicals` or `{tenant}/batch-documents` objects in MinIO.

Root cause. The REST upload surface lives in the gateway, outside farm-service, and only the
global AuthGuard and TenantIsolationGuard run on it. No handler states an access spec, and the
chemical or batch id from the body or path is never checked against farm data. Any tenant member
(an HR clerk or a sensor operator, for example) can upload to or delete from any chemical or
batch. That is a data-loss path for regulatory evidence such as MSDS sheets and health
certificates.

Fix tier 1 (impossible) plus tier 3. PKG-43 marks the chemical and batch document handlers
`Access.module('farm')` with write intent and calls `request.farm.validateSiteAssignment` for the
target entity. A caller without a farm grant, or outside the entity's site, is refused before any
byte is stored or deleted.

Pinned by the upload access spec (role B gets 403 on /api/upload/) and the REST /api/upload rows
of the §7 access matrix.

Rule broken. D2 (farm-private data is written only by farm grant holders) and the plan's decided
default that a site assignment is a physical restriction for MODULE_USER callers.

Evidence:

```text
apps/gateway-api/src/upload/upload.controller.ts:143-144 (UploadController carries no role, module or site decision)
apps/gateway-api/src/upload/upload.controller.ts:240-252 (chemical upload checks only req.user and tenantId)
apps/gateway-api/src/upload/upload.controller.ts:287-291 (stores under the client-supplied chemicalId without verifying the chemical)
apps/gateway-api/src/upload/upload.controller.ts:647-684 (batch-document delete checks only tenant, then deletes the object)
apps/gateway-api/src/app.module.ts:542-588 (the global guards are AuthGuard and TenantIsolationGuard; no role or module guard runs on REST)
```

## SEC-HIGH-209

Defect. gateway-api POST /api/upload/presigned-url signs a download URL valid up to 24 hours for
any object under the caller tenant prefix, checking neither the entity type nor the caller module,
so any tenant member can download farm chemical and batch documents.

Package PKG-43, release R4, severity HIGH.

Where. `UploadController.getPresignedUrl` decodes the requested path, rejects traversal and null
bytes, and requires the four-segment shape and the caller's tenant prefix. It then asks MinIO for
a presigned GET valid for up to 24 hours.

Root cause. The endpoint treats the storage path as the authority. The `entityType` segment is
never mapped to an owning module, so tenant membership alone unlocks every object type in the
layout `MinioClientService.generateFilePath` gives all writers. A member without a farm grant who
learns a document path can download chemical or batch documents. The URL is a bearer credential
that outlives a later revocation by up to a day.

Fix tier 1 (impossible). PKG-43 resolves `entityType` through a closed typed map to an AccessSpec
(chemicals and batch-documents to farm, telemetry-archive to sensor) and decides with
decideAccess. An unknown entityType returns 403.

Pinned by the upload access spec (role B gets 403 on /api/upload/) and the /api/upload rows of the
§7 access matrix.

Rule broken. D2: a module's private objects are readable only with that module's grant, on every
surface including storage URLs.

Evidence:

```text
apps/gateway-api/src/upload/upload.controller.ts:752-763 (only req.user and tenantId are checked)
apps/gateway-api/src/upload/upload.controller.ts:792-798 (any {tenantId}/{entityType}/{entityId}/{filename} path is accepted)
apps/gateway-api/src/upload/upload.controller.ts:800-803 (the only authorization is the tenant prefix)
apps/gateway-api/src/upload/upload.controller.ts:805-810 (a URL valid up to 86400 s is minted)
libs/storage/src/minio-client.service.ts:136-144 (every storage writer uses the same {tenantId}/{entityType}/{entityId}/{filename} layout)
```

## AISAFETY-HIGH-034

Defect. The farm NATS AI path carries no caller identity: all 40 request.farm.ai. read subjects
and request.farm.createTask accept a tenantId-only payload, so farm-service answers with
tenant-wide farm data and writes AI tasks under an unchecked createdBy string without any
module-grant or site-scope decision.

Package PKG-09, release R5, severity HIGH.

Where. `libs/event-contracts/src/farm-ai-queries.ts` types every `request.farm.ai.*` request as `{
tenantId }` plus query fields. The guard admits any record whose tenantId is a UUID.
`respondAiQuery` is the single farm-service chokepoint for all forty subjects, and it checks shape
only. `CreateTaskResponder` writes a task under whatever `createdBy` the payload names.

Root-cause chain. ai-service holds the human caller in `ToolExecutionContext.userId`, but
`FarmAiQueryTool.run` sends only `ctx.tenantId`. The contract has no caller slot and no
`FORBIDDEN` code, so farm-service can neither make a module-grant decision nor apply the caller's
site scope. Every reply is tenant-wide: an operator assigned to one site gets every site's
batches, finance and water chemistry through the assistant, and task attribution is whatever
string arrives.

Fix tier. 1 (impossible): a required, validated caller in the contract makes an identity-less
request unrepresentable, and the chokepoint decides access. 3 (detectable): the farm-ai-query
contract invariant flags a subject without it.

Pinned by. Responder specs for FORBIDDEN and INVALID_REQUEST, an S1 operator asking about S2, and
a createTask spec that attributes the task to the validated caller.

Rule broken. D2 (farm-private data is reachable only with the farm grant) and the site-assignment
default, which together require that an AI tool never reads or writes more than its human caller
could.

Evidence:

```text
libs/event-contracts/src/farm-ai-queries.ts:91 (AiQueryRequest is { tenantId } only; the contract has no caller field)
libs/event-contracts/src/farm-ai-queries.ts:95 (AiQueryErrorCode is INVALID_REQUEST | INTERNAL_ERROR; no FORBIDDEN outcome exists)
apps/farm-service/src/common/nats/ai-query-responder.ts:42 (the single chokepoint for all forty subjects runs the handler under withTenantContext(payload.tenantId) after a shape check only)
apps/ai-service/src/tools/farm/farm-ai-query.tool.ts:50 (request is model fields plus ctx.tenantId; ctx.userId, declared at tools/core/tool.interface.ts:58, is never sent)
apps/farm-service/src/task/responders/create-task.responder.ts:55 (createTask only checks createdBy is non-empty, then writes the task under payload.createdBy at :89-94)
```

## AISAFETY-HIGH-035

Defect. AI action confirmation (confirmAiAction to request.ai.executeAction) authorizes the
confirming user by channel membership alone and executes the stored tool under the original
requester's stored roles, so a member without authority, or a requester whose role was revoked,
can release an actuation for up to 24 hours.

Package PKG-09, release R5, severity HIGH.

Where. `confirmAiAction` in `apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts`
authorizes the confirming user by active membership of the action's channel, then forwards
`confirmedBy: userId`. `AiActionResponder` checks only that the ids are present.
`ActionProposalService.executeProposal` then runs the stored tool as `proposal.requestedBy`, with
the stored `requesterRoles` and `actuationPolicy: 'allowed'`.

Root-cause chain. The confirmation is treated as the authorization, but nothing checks the
confirmer's own authority. Any channel member can release an actuation that runs under the
requester's authority as it was when the proposal was made. That includes a Company viewer added
to the AI channel, or the requester after their role was demoted inside the 24-hour window.
`confirmedBy` is recorded on the row but never decided on, and the payload is a hand-written
interface outside libs/event-contracts.

Fix tier. 1: the execute request carries a typed, validated confirming caller, and access is
decided against that caller's current grants before the proposed-to-executing claim.

Pinned by. A confirm-after-revocation spec and a non-entitled-confirmer spec on the responder.

Rule broken. D2 and the repo rule of root-cause enforcement: an actuation must be decided against
a validated caller's current authority at execution time, never against a caller-supplied id
string or a role snapshot.

Evidence:

```text
apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:356 (the confirmer is authorized by active membership of the action's channel only)
apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:390 (request.ai.executeAction forwards confirmedBy as a bare user-id string)
apps/ai-service/src/actions/ai-action.responder.ts:24 (ExecuteActionNatsRequest is a local all-optional interface; :48 checks presence only)
apps/ai-service/src/actions/action-proposal.service.ts:180 (the tool runs as proposal.requestedBy with the stored requesterRoles; the confirmer's current authority is never read)
apps/ai-service/src/actions/action-proposal.service.ts:191 (actuationPolicy is forced to 'allowed' on confirmation)
apps/ai-service/src/actions/action-proposal.service.ts:51 (the confirmation window is 24 hours)
```

## FARM-MEDIUM-469

Defect. The legacy farm NATS subjects getWaterQualityOverview, getFeedingOverview,
getHarvestOverview, getBatchOverview, getTankRegistry and createTask declare their payloads
separately in each responder and caller outside libs/event-contracts, and the readers answer []
for malformed or failed requests.

Package PKG-09, release R5, severity MEDIUM.

Where. Five farm readers (the water-quality, feeding, harvest and batch overview responders and
the tank-registry responder) and `request.farm.createTask` predate the typed farm AI contract.
Each declares its request interface inside the farm-service responder. ai-service tools and
messaging's knowledge extraction re-declare the reply types and send string-literal subjects.

Root-cause chain. No shared type exists, so producer and consumers drift without a compile error.
The contract-SSoT invariant proves responder, tool and grants only for `FARM_AI_QUERY_SUBJECTS`
(farm-ai-queries.ts:7-10), so these subjects are outside it. The readers return `[]` both for a
malformed request and for a failure, which the contract header records as indistinguishable from
no data. Any caller field added to the typed path cannot reach these subjects either.

Fix tier. 1: request and reply types and their guards live once in libs/event-contracts, and both
sides import them. 3: the contract-SSoT invariant covers every `request.farm.*` subject.

Pinned by. Guard specs per legacy subject, and the extended farm-ai-query-contract-ssot invariant.

Rule broken. Repo rule of one owner per contract with hierarchy impossible &gt; automatic &gt;
detectable: NATS request and reply shapes are owned by libs/event-contracts, and a cross-service
subject declared twice can drift silently.

Evidence:

```text
apps/farm-service/src/water-quality/responders/get-water-quality-overview.responder.ts:18 (request interface declared inside the farm responder, not in libs/event-contracts; same pattern in the feeding :18, harvest :15, batch :16 and tank-registry :22 responders)
apps/farm-service/src/water-quality/responders/get-water-quality-overview.responder.ts:44 (a malformed request answers [] and a failure answers [] at :83, indistinguishable from no data)
apps/ai-service/src/tools/farm/get-farm-water-quality.tool.ts:14 (ai-service re-declares WaterQualityReading and sends the string-literal subject at :63)
apps/ai-service/src/tools/farm/create-task.tool.ts:25 (a second hand-written copy of CreateTaskNatsResponse; the request shape lives in create-task.responder.ts:17)
apps/messaging-service/src/ai/services/knowledge-extraction.service.ts:422 (a third service calls request.farm.getTankRegistry by string literal)
libs/event-contracts/src/farm-ai-queries.ts:13 (the contract itself records that the overview responders' [] cannot be told from no data)
```

## SENSOR-HIGH-201

Defect. sensor-service GraphQL resolvers decide access by tenant and global account role only:
sensors, readings, edge devices and their federation references are served to every authenticated
tenant member with no sensor-module decision and no site scope, and SiteAuthorizationService has
no caller in sensor-service.

Package PKG-11, release R5, severity HIGH.

Where. sensor-service registers ServiceIdentityGuard, TenantGuard, RolesGuard and an opt-in
TenantPermissionGuard globally. Read resolvers such as `sensor`, `readings`, `edgeDevices` and the
Sensor and SensorReading reference resolvers carry no decorator. RolesGuard therefore admits any
authenticated user (libs/backend-common/src/guards/roles.guard.ts:67-72), and the queries filter
by tenantId alone.

Root-cause chain. The service has no module-access decision, and the tenant `modules` claim is
only copied at the gateway. So a member with no sensor role, such as a Company viewer or a
farm-only manager, reads every sensor, reading and edge device. Site restriction is missing too:
`edgeDevices` treats `siteId` as an optional client filter, and the shared `resolveSiteScope` is
never called here, so an operator assigned to one site sees all sites.

Fix tier. 1: a class-level sensor module declaration enforced by the guard, plus list predicates
built from the server-derived site scope. 3: the guard-adoption invariant flags any resolver left
unclassified.

Pinned by. Edge-device, reference and readings specs. Roles A and B get FORBIDDEN on every sensor
operation, and an S1 operator never sees an S9 device.

Rule broken. D2 (readings, devices, edge devices and PLC/SCADA are sensor-private and need the
sensor grant) and the decided default that a site assignment restricts every module where the user
is MODULE_USER.

Evidence:

```text
apps/sensor-service/src/app.module.ts:507 (global guards are ServiceIdentity, Tenant, Roles and opt-in TenantPermission; none decides a module, :507-536)
apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts:85 (sensor by id has no role decorator and filters by tenantId only)
apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts:174 (readings over any sensor id and time range, tenant filter only)
apps/sensor-service/src/edge-device/edge-device.resolver.ts:98 (edgeDevices takes siteId as an optional client filter; when it is absent, every site is returned)
apps/sensor-service/src/sensor/resolvers/sensor-reading.resolver.ts:76 (the SensorReading federation reference resolves on tenantId only)
libs/backend-common/src/security/site-authorization.service.ts:67 (resolveSiteScope exists, but grep finds zero uses in apps/sensor-service)
```

## SENSOR-HIGH-202

Defect. The SCADA socket (/scada-ws, routed by nginx straight to sensor-service) admits any valid
tenant access token, joins it to the tenant-wide room and streams tag values, DAQ history and
alarm status for every site, with no sensor-module decision, no site scope and no token
revalidation after connect.

Package PKG-11, release R5, severity HIGH.

Where. nginx proxies `/scada-ws/` straight to sensor-service, bypassing gateway-api and its socket
guards. `ScadaRuntimeGateway.handleConnection` verifies the access token, requires only a
tenantId, and joins the socket to `tenant:<id>`.

Root-cause chain. The handshake makes no module decision, so any tenant member can open the
socket. From there, TAG_SUBSCRIBE is checked only against the tenant's tag registry, DAQ_QUERY
reads history by tenantId only, and alarm status is broadcast to the whole tenant room. Live
process values, trends and alarm state for every site reach users with no sensor role and no site
assignment. The gateway-api sockets use `WsTokenRevalidator`, but this gateway never revalidates,
so a deactivated or demoted user keeps streaming until they disconnect.

Fix tier. 1: the handshake decides from the sensor grant and joins module and site rooms. 2: the
shared revalidator drops a socket automatically after revocation.

Pinned by. Socket specs: roles A and B are refused at handshake, an S1 operator cannot subscribe
to an S9 tag, and a revoked socket drops within 60 s.

Rule broken. D2 (PLC/SCADA is sensor-private) with the site-assignment default, and the section 7
timing rule that sockets drop within 60 s after a revocation.

Evidence:

```text
infrastructure/nginx/droplet.conf:311 (/scada-ws/ is proxied directly to sensor-service, so no gateway guard runs)
apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:211 (the handshake rejects only a token without tenantId)
apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:240 (every accepted socket joins the room tenant:<id>)
apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:561 (DAQ_QUERY streams tag history fenced by tenantId only; TAG_SUBSCRIBE at :323 is fenced by the tenant tag registry only)
apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:796 (alarm status is broadcast to the whole tenant room)
libs/backend-common/src/websocket/tenant-socket-guards.ts:113 (WsTokenRevalidator exists and gateway sockets use it, e.g. apps/gateway-api/src/websocket/sensor-readings.gateway.ts:113; the SCADA gateway never does)
```

## SENSOR-HIGH-203

Defect. Sensor actuation authority comes from the account-level role claim: the SCADA gateway
casts the raw JWT role to HmiRole without mapping to gate tag writes and alarm acknowledgements,
and approvePlcAlarm maps a global MODULE_MANAGER of any module to PLC approval level 2.

Package PKG-11, release R5, severity HIGH.

Where. `ScadaRuntimeGateway` types the JWT `role` claim as `HmiRole` and returns the verified
token with an unchecked cast. The connection role is that raw claim. TAG_WRITE, ALARM_ACK and
ALARM_ACK_ALL compare it with the lowercase list `operator, engineer, supervisor, admin`, but
auth-service mints platform values such as `TENANT_ADMIN`. `approvePlcAlarm` maps `MODULE_MANAGER`
to approval level 2 and `TENANT_ADMIN` to level 3.

Root-cause chain. No sensor module role exists, so physical-control authority is read from the
account role. On the socket, the verdict depends on a vocabulary the issuer does not mint, and a
cast stands in for a mapping, so no sensor authority is consulted. On PLC alarms, any global
MODULE_MANAGER, including a farm or HR manager, approves at level 2.

Fix tier. 1: authority comes from the caller's sensor module role through one typed mapping, so an
unmapped claim cannot authorize. 3: the no-global-role-authz invariant flags users.role reads in
sensor-service.

Pinned by. Socket write and acknowledgement specs per module role, and a PLC approval spec where a
farm-only manager is refused level 2.

Rule broken. Target model section 2: users.role is an account role only, and module authority
comes from the module grant; repo rule against authorizing on an unvalidated cast.

Evidence:

```text
apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:115 (TokenPayload declares the JWT role claim as HmiRole)
apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:971 (the verified token is returned with an unchecked cast to TokenPayload)
apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:221 (the connection role is the raw role claim)
apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:442 (TAG_WRITE checks that claim against the lowercase list at :101; ALARM_ACK :592 and ALARM_ACK_ALL :637 do the same)
apps/auth-service/src/modules/authentication/services/token.service.ts:370 (the issuer mints role and roles as platform Role values such as TENANT_ADMIN and MODULE_USER)
apps/sensor-service/src/plc-control/resolvers/plc-control.resolver.ts:705 (PLC approval level is derived from global users.role, so any MODULE_MANAGER gets level 2, :704-711)
```

## AISAFETY-HIGH-036

Defect. The AI persona module gate checks the tenant-role capability ai_specialties:&lt;module&gt;
instead of module membership, and auth-service seeds ai_specialties:farm as granted on every
default role including Viewer, so every tenant member can drive the farm specialist and its
farm-data tools.

Package PKG-12, release R5, severity HIGH.

Where. `composeEntry` in `libs/shared-contracts/src/ai/persona-catalogue.ts` turns a specialty's
`requiresModule` into the RBAC capability `ai_specialties:<module>`.
`AgentProfileService.assertPersonaPermitted` and messaging's `createChannel` both check that
capability with `hasAllResourcePermissions`. auth-service seeds `ai_specialties: { farm: true }`
on all five default roles, Viewer included.

Root-cause chain. A persona's module ownership is modelled as a role permission, not as membership
of the module. The default seed grants it to every role. As a result every tenant member,
including a Company viewer with no farm role, passes the farm specialist gate, and the
specialist's farm tools then read tenant-wide farm data over the NATS path. A tenant admin can
revoke the capability per role, but never per module grant.

Fix tier. 1: a persona with `requiresModule` requires the caller's grant in that module, decided
by the same access function as every other module operation.

Pinned by. Persona gate specs: role B is refused the farm specialist, and a member whose farm
grant is revoked is refused it on the next turn.

Rule broken. D4 (ai is module-scoped) and D2: a persona that requires a module must require the
caller's grant in that module.

Evidence:

```text
libs/shared-contracts/src/ai/persona-catalogue.ts:257 (a specialty's requiresModule becomes the RBAC capability ai_specialties:<module>)
apps/ai-service/src/agent/agent-profile.service.ts:202 (the persona gate is hasAllResourcePermissions over that capability list)
apps/auth-service/src/modules/tenant/services/tenant-role.service.ts:297 (the Viewer role is seeded with ai_specialties farm: true; so are Supervisor :148, Technician :176, Feed Manager :206 and Operator :250)
apps/auth-service/src/modules/tenant/services/permission-catalogue.ts:131 (ai_specialties is a role permission resource, not a module grant)
apps/messaging-service/src/channel/resolvers/channel.resolver.ts:201 (AI channel creation applies the same capability check)
```

## ALERT-HIGH-018

Defect. alert-engine serves alertHistory and activeAlertCounts tenant-wide to any authenticated
member, treating module and siteId as optional client filters, and lets any member acknowledge or
resolve any alarm by id without comparing the alarm's module or site to the caller.

Package PKG-12, release R5, severity HIGH.

Where. `AlertResolver.getAlertHistory` and `getActiveAlertCounts` carry no role decorator, so
RolesGuard admits any authenticated member. `applyAlertHistoryScope` narrows only when the client
passes `siteId` or `module`. `acknowledgeAlert` and `resolveAlert` accept every account role and
load the alarm by id and tenant only.

Root-cause chain. The scope of an alarm read comes from the client, not the server. Omitting the
arguments returns every module's and every site's alarms: farm mortality, FCR, feeding and
low-stock alarms reach a sensor-only member, and sensor alarms reach a farm-only member. Rows with
a NULL module go to everyone. A member who obtains an alarm id can acknowledge or clear an alarm
in a module they do not hold, changing that module's alarm state.

Fix tier. 1: the read predicate is built from the caller's alert scope, with the module required
to be in that scope set. Acknowledge and resolve assert the alarm's module, and client arguments
can only narrow.

Pinned by. Specs: role A sees only farm alarms, role A passing SENSOR gets FORBIDDEN, and
acknowledging an out-of-scope alarm is refused.

Rule broken. D4 (alert is module-scoped) and D2, together with the decided default that
unattributed alarm rows are visible only to callers with full scope.

Evidence:

```text
apps/alert-engine/src/alert/resolvers/alert.resolver.ts:87 (alertHistory has no role decorator; module and siteId are optional arguments)
apps/alert-engine/src/alert/resolvers/alert.resolver.ts:137 (activeAlertCounts has the same open shape)
apps/alert-engine/src/alert/services/alert-history-scope.ts:25 (scope narrows only when the client passes siteId or module; when absent, the whole tenant is returned)
apps/alert-engine/src/alert/resolvers/alert.resolver.ts:218 (acknowledgeAlert, and resolveAlert at :238, admit every account role)
apps/alert-engine/src/alert/services/alert-rule.service.ts:363 (acknowledge and resolve load the alarm by id and tenant only, never by module, :357-395)
libs/backend-common/src/guards/roles.guard.ts:67 (an operation without @Roles admits any authenticated user)
```

## ALERT-HIGH-019

Defect. alert-engine alert rules and escalation policies are readable by every tenant member and
writable by any holder of the global MODULE_MANAGER account role, although rules evaluate only
SensorReading, so a farm or HR manager can change sensor alarm thresholds, recipients and on-call
schedules.

Package PKG-12, release R5, severity HIGH.

Where. `alertRule`, `alertRules`, `escalationPolicy`, `escalationPolicies`,
`defaultEscalationPolicy` and `currentOnCallUser` carry no role decorator. Creating and updating
rules, and the create, update, clone, suppression-window and on-call mutations on policies,
require only `TENANT_ADMIN` or `MODULE_MANAGER`.

Root-cause chain. `MODULE_MANAGER` is a single tenant-wide account role with no module attached.
Holding it for any module satisfies these guards. Rule evaluation consumes only SensorReading
(`evaluateSensorReading`), so a farm or HR manager can edit sensor thresholds, notification
recipients and on-call schedules. Meanwhile every member, including a Company viewer, reads the
rule set, its recipients and the current on-call user.

Fix tier. 1: rules and policies are declared sensor-module operations, and the guard decides from
the sensor grant. 3: the guard-adoption invariant flags any alert resolver left unclassified.

Pinned by. Specs: a farm-only manager is refused createAlertRule and updateEscalationPolicy, and
role B is refused the rule and policy reads.

Rule broken. D4 and D2: rules evaluate only SensorReading, so writing them is a sensor-module
operation, not a tenant-wide account-role operation.

Evidence:

```text
apps/alert-engine/src/alert/resolvers/alert.resolver.ts:50 (alertRules, and alertRule at :39, carry no role decorator)
apps/alert-engine/src/alert/resolvers/alert.resolver.ts:157 (createAlertRule, and updateAlertRule at :176, admit TENANT_ADMIN or MODULE_MANAGER)
apps/alert-engine/src/alert/resolvers/escalation-policy.resolver.ts:82 (currentOnCallUser and the policy reads at :50-77 carry no role decorator)
apps/alert-engine/src/alert/resolvers/escalation-policy.resolver.ts:98 (policy create, update, clone, suppression and on-call mutations admit any MODULE_MANAGER)
apps/alert-engine/src/alert/services/alert-evaluation.service.ts:79 (rule evaluation consumes only SensorReading)
libs/backend-common/src/decorators/roles.decorator.ts:85 (MODULE_MANAGER is one tenant-wide account role, with no module attached)
```

## RBAC-HIGH-038

Defect. hydroponics-service resolvers gate every query and mutation with @Roles(MODULE_USER),
which every account role satisfies, so any member of any tenant reads and creates hydroponics
configurations and any global MODULE_MANAGER deletes them, with no hydroponics module decision.

Package PKG-12, release R5, severity HIGH.

Where. `SetupResolver` in hydroponics-service guards the class with TenantGuard and each operation
with `@Roles(Role.MODULE_USER)`. Under the role hierarchy, every account role satisfies
MODULE_USER. Delete lets MODULE_MANAGER, TENANT_ADMIN and SUPER_ADMIN remove any configuration,
while MODULE_USER is limited to their own.

Root-cause chain. The service makes no module decision, and the tenant `modules` claim only
reaches a copy at the gateway. So any member of any tenant can list, create and update nutrient
configurations, even in a tenant that has not licensed hydroponics. A global MODULE_MANAGER of
farm or HR can delete configurations created by others, which is a data-loss path.

Fix tier. 1: a class-level hydroponics module gate enforced by the shared guard, so no operation
is reachable without the grant. 3: the guard-adoption invariant covers the service.

Pinned by. A resolver spec where roles A and B get FORBIDDEN on every hydroponics operation and a
hydroponics grant holder succeeds.

Rule broken. D3 (hydroponics is reserved and only gated) and D2: hydroponics-private nutrient
configuration is reachable only with a hydroponics grant.

Evidence:

```text
apps/hydroponics-service/src/setup/resolvers/setup.resolver.ts:13 (the class is guarded by TenantGuard only)
apps/hydroponics-service/src/setup/resolvers/setup.resolver.ts:49 (list requires @Roles(Role.MODULE_USER); so do create :97, update :117 and delete :150)
libs/backend-common/src/decorators/roles.decorator.ts:82 (role hierarchy: every account role satisfies MODULE_USER, :82-87)
apps/hydroponics-service/src/setup/resolvers/setup.resolver.ts:172 (any MODULE_MANAGER, TENANT_ADMIN or SUPER_ADMIN may delete any configuration)
apps/gateway-api/src/guards/tenant-isolation.guard.ts:233 (the tenant modules claim is only copied into context and never decides access)
```

## MSG-HIGH-085

Defect. messaging-service channels carry no module: an AI channel bound to a module persona admits
any active tenant user through addChannelMember, and its messages, including farm data the AI
retrieved, are readable on channel membership alone, because the caller capabilities messaging
resolves contain no module grants.

Package PKG-25, release R5, severity HIGH.

Where. `Channel` stores `aiPersona` but no module. `createChannel` checks the persona capability
for the creator only. `AddMemberHandler` admits any active tenant user to a GROUP or AI channel,
and message reads require only channel membership. The bridge's resolved caller capabilities hold
roles and resourcePermissions, with no module grants.

Root-cause chain. A module channel cannot be represented, so no read, send or join path can ask
for the module. Take an AI channel driven by the farm specialist: its history holds batches,
finance and water chemistry that the tools fetched. Any member added to it can read that history,
including a Company viewer or an HR clerk. A member whose farm access is later removed keeps
reading it.

Fix tier. 1: channels carry a module, and listing, reading, sending and joining a module channel
require its grant. 3: the module-access classification invariant enrols messaging.

Pinned by. Specs: a sensor channel is invisible to a farm-only member, revoking the grant hides
the channel, and role B cannot join a farm AI channel.

Rule broken. D4 (messaging is module-scoped) and the decided channel default that module channels,
AI channels included, are usable only by holders of that module.

Evidence:

```text
apps/messaging-service/src/channel/entities/channel.entity.ts:95 (a channel stores aiPersona but has no module column)
apps/messaging-service/src/channel/commands/add-member.handler.ts:66 (admission checks only that the target is an active tenant user; DIRECT at :78 is the only type refused)
apps/messaging-service/src/channel/resolvers/channel.resolver.ts:199 (the persona capability is checked for the creator, at creation only)
apps/messaging-service/src/message/queries/get-messages-since.handler.ts:51 (message reads require channel membership alone)
apps/messaging-service/src/ai/services/ai-caller-capabilities.service.ts:47 (resolved caller capabilities are roles and resourcePermissions, with no module grants)
```

## MSG-MEDIUM-086

Defect. messaging-service caches each caller's AI capabilities in Redis for 60 seconds with no
eviction path, so a revoked role, permission or deactivated account keeps authorizing AI turns,
and a newly granted one stays denied, until the entry expires.

Package PKG-25, release R5, severity MEDIUM.

Where. `AiCallerCapabilitiesService.resolve` reads `ai:caller-caps:<tenant>:<user>` from Redis and
returns it without consulting auth-service. The entry is written with a 60 s TTL. The key is
referenced nowhere else in the repository, so no role, permission or deactivation change removes
it.

Root-cause chain. Revocation is left to cache expiry. After a tenant admin removes
`ai_assistant:use` or a persona capability, or deactivates the user, the bridge keeps authorizing
that user's AI turns for up to a minute. A cached empty denial keeps a newly granted user out for
the same time. The service header documents this staleness instead of removing it, which is tier-4
handling of a revocation path.

Fix tier. 2 (automatic): an auth event on any role, permission, grant or account-state change
evicts the entry. 3: a timing row in the access matrix detects an entry that survives revocation.

Pinned by. A bridge spec where a revoked grant denies the next AI turn without waiting for the TTL.

Rule broken. Section 7 mandatory timing cell (after a revocation the messaging cache entry is
evicted) and the repo hierarchy that prefers an automatic mechanism over documented staleness.

Evidence:

```text
apps/messaging-service/src/ai/services/ai-caller-capabilities.service.ts:40 (CACHE_TTL_SECONDS = 60)
apps/messaging-service/src/ai/services/ai-caller-capabilities.service.ts:72 (a cached entry short-circuits the auth-service lookup, :72-80)
apps/messaging-service/src/ai/services/ai-caller-capabilities.service.ts:126 (the entry, including an empty denial, is written with the TTL; the ai:caller-caps key is referenced nowhere else)
apps/messaging-service/src/ai/services/ai-caller-capabilities.service.ts:21 (the header documents the one-minute staleness as the revocation bound)
apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:203 (the bridge authorizes every AI turn from this cache)
```

## ALERT-HIGH-020

Defect. Alert notification recipients are free-form: alert rule recipients and escalation-level
notifyUserIds accept any strings, alert-engine copies them verbatim into AlertTriggered, and
notification-service dispatches to them from a locally re-declared event type without module or
site, so sensor alarms reach users without the.

Package PKG-44, release R5, severity HIGH.

Where. `CreateAlertRuleInput.recipients` and `EscalationLevelInput.notifyUserIds` accept any
string array. alert-evaluation's event builder copies `rule.recipients` verbatim into
AlertTriggered. notification-service's `AlertTriggeredHandler` dispatches to those recipients from
a locally re-declared event interface that carries neither module nor site.

Root-cause chain. Recipients are never checked against the alarm's module, either when saved or at
fan-out. A rule author, today any global MODULE_MANAGER, can route sensor alarm content (sensor
id, parameter, value and threshold) to users who hold no sensor role. Recipients also keep
receiving after their access is removed. notification-service cannot re-check, because the event
it consumes does not say which module or site the alarm belongs to.

Fix tier. 1: saving a rule or escalation level rejects recipients who lack the module, and fan-out
filters through the module's members. 3: the notification handler map invariant covers
AlertTriggered.

Pinned by. A policy-save spec that rejects a non-member recipient, and a handler spec where a
member whose grant was revoked receives nothing.

Rule broken. D2 and D4: an alarm of module m is delivered only to holders of module m.

Evidence:

```text
apps/alert-engine/src/alert/dto/create-alert-rule.dto.ts:89 (rule recipients is any optional string array, with no membership validation)
apps/alert-engine/src/alert/dto/escalation-policy.dto.ts:51 (escalation-level notifyUserIds is any string array)
apps/alert-engine/src/alert/services/alert-evaluation.service.ts:509 (rule.recipients is copied verbatim into the AlertTriggered event)
apps/notification-service/src/notification/event-handlers/alert-triggered.handler.ts:71 (notification-service re-declares the event locally, with no module or site field, :71-90)
apps/notification-service/src/notification/event-handlers/alert-triggered.handler.ts:190 (dispatch goes to the event recipients without a membership check)
```

## MSG-HIGH-087

Defect. notification-service sends the farm FeedingDailySummary push and in-app notification to
every device-token holder of the tenant, with no module or site filter, and cuts the list at 100
recipients in user_id order, so farm feeding figures reach users without farm access while farm
staff can be dropped.

Package PKG-44, release R5, severity HIGH.

Where. `FeedingDailySummaryHandler.handle` resolves recipients from the tenant id alone, and
`resolveRecipients` selects the newest device token of every user in the tenant. Each recipient
gets a push and an in-app notification carrying planned and actual feed kilograms, completion
rate, underfed units and missed meals.

Root-cause chain. notification-service has no mapping from a notification event type to the module
it belongs to, and no query for a module's members. The farm summary therefore fans out to every
device user, so members with no farm role, such as an HR clerk or a Company viewer, receive
farm-private production figures. The list is then cut at 100 rows ordered by user_id, so in larger
tenants farm staff can be dropped while non-farm users are kept.

Fix tier. 1: a typed map from event type to access spec, with recipients drawn from the module's
members (filtered by site where the event has one). 3: an invariant requires a map entry for every
notification handler.

Pinned by. A handler spec where role B with a registered device token receives no
FeedingDailySummary.

Rule broken. D2: farm-private feeding data must not reach a user without the farm grant through
push or in-app notifications.

Evidence:

```text
apps/notification-service/src/notification/event-handlers/feeding-daily-summary.handler.ts:85 (recipients are resolved from the tenant id alone)
apps/notification-service/src/notification/event-handlers/feeding-daily-summary.handler.ts:195 (resolveRecipients selects the newest device token of every user in the tenant, :195-202)
apps/notification-service/src/notification/event-handlers/feeding-daily-summary.handler.ts:111 (a push with planned and actual kg, completion rate, underfed units and missed meals goes to each recipient)
apps/notification-service/src/notification/event-handlers/feeding-daily-summary.handler.ts:139 (an in-app notification with the same farm figures is written for each recipient)
apps/notification-service/src/notification/event-handlers/feeding-daily-summary.handler.ts:204 (the list is cut at MAX_SUMMARY_RECIPIENTS = 100, defined at :19, in user_id order)
```

## ALERT-MEDIUM-021

Defect. The tenant default escalation policy has no database integrity: is_default has no unique
index and create or update clears every default then saves in a separate non-transactional
statement, so a tenant can hold two defaults or none, and with none an unmatched incident is never
escalated.

Package PKG-22, release R6, severity MEDIUM.

Where. `createPolicy` and `updatePolicy` clear every default with a bulk update and then save the
new policy as a second statement, with no transaction
(escalation-policy.service.ts:86-95,124-129,507-512). `is_default` has no partial unique index
(alert Baseline.ts:16). `getDefaultPolicy` takes the first flagged row of a cached list held
separately by each instance.

Root cause. The one-default rule exists only in application code.

- Two concurrent saves both clear and both insert. The tenant is left with two defaults, and the
  priority and created_at order picks one arbitrarily.
- A save that fails after the clear leaves no default. `startEscalation` then logs an incident
  that matches no policy and drops it (escalation-manager.service.ts:275-277).

The per-module defaults that PKG-22 introduces cannot be built on this.

Fix, tier 1. PR1 (R6):

- resolve existing duplicates (highest priority, then earliest created_at), with counts per tenant;
- build a partial unique index on default policies CONCURRENTLY;
- clear the old default and set the new one in one transaction.

Pinned by a migration-harness spec for the dedup and the index, and a service spec in which a
failed save leaves the previous default in place.

Rule broken. The repo rule ranks impossible above automatic above detectable, so a
one-default-per-scope invariant must be impossible to break in the database rather than kept by
two unsynchronised statements

Evidence:

```text
apps/alert-engine/src/escalation/escalation-policy.service.ts:86-95 (all defaults are cleared, then the new policy is saved, outside a transaction)
apps/alert-engine/src/escalation/escalation-policy.service.ts:124-129 (the update path repeats the same two steps)
apps/alert-engine/src/escalation/escalation-policy.service.ts:507-512 (unsetDefaultPolicies is an unguarded bulk update)
apps/alert-engine/src/database/migrations/1800000000000-Baseline.ts:16 (is_default boolean with no partial unique index)
apps/alert-engine/src/escalation/escalation-policy.service.ts:195-197 (getDefaultPolicy takes the first isDefault row of the cached list)
apps/alert-engine/src/escalation/escalation-manager.service.ts:275-277 (no policy: a warning is logged and null returned, so the incident is not escalated)
```

## FE-MEDIUM-381

Defect. The console has no HR workspace: Company hosts the whole HR module, including a pay group
(payroll, HR finance, HR analytics) gated only by the global TENANT_ADMIN or MODULE_MANAGER role,
and the hr-module remote exposes PayrollPage and the HR dashboard outside its ./Module entry.

Package PKG-26, release R6, severity MEDIUM.

Where. The console knows four workspaces: `aqua`, `gh`, `ctl` and `org` (railTypes.ts:20). The
Company (`org`) workspace carries the whole HR module (org.ts:51-85). That includes an `org-pay`
group with payroll, HR finance and HR analytics, gated only by the global roles TENANT_ADMIN or
MODULE_MANAGER. The hr-module remote also exposes `./Dashboard` and `./Payroll` beside `./Module`.

Root cause. Company was defined as "consolidated finance, workforce, facility and the account"
before D2 and D6. HR therefore had no home of its own, and pay became a Company page offered to
any module's manager. The direct remote exposures let any host mount PayrollPage outside the
module's routes. API enforcement of pay belongs to PKG-07; this finding covers the UI surface.

Fix, tier 1+3.

- Add `hr` as a workspace id (railTypes, WorkspaceMenu, theme token).
- Move the HR pages into a new `workspaces/hr.ts`.
- Remove the workforce area from `org.ts`.
- Delete the two extra exposures.

Pinned by the definitions, buildConsoleNav and rootLanding specs, and by the HR finance boundary
invariant, which allows PayrollPage only through `./Module`. Company then has no workforce area.

Rule broken. D6 keeps salary and HR finance visible only inside HR, and D2 says a Company role
never sees module-private data

Evidence:

```text
web/shared-ui/src/components/Layout/console/railTypes.ts:20 (the workspaces are aqua, gh, ctl and org; there is no hr)
web/shell/src/console/nav/workspaces/org.ts:51-61 (Company carries the HR workforce area)
web/shell/src/console/nav/workspaces/org.ts:74-78 (the org-pay group lists payroll, hrFinance and HR analytics in Company)
web/shell/src/console/nav/pages/hr.ts:16 (PAYROLL_ROLES is TENANT_ADMIN, MODULE_MANAGER)
web/shell/src/console/nav/pages/finance.ts:14 (FINANCE_ROLES, which gates hrFinance, is TENANT_ADMIN, MODULE_MANAGER)
web/modules/hr-module/vite.config.ts:24-28 (./Dashboard and ./Payroll are exposed beside ./Module)
```

## RBAC-HIGH-039

Defect. Non-admin users persisted with users.role = MODULE_MANAGER hold manager power in every
module: token minting copies the global role and skips site assignments for it, and the
module-blind role hierarchy admits it at every MODULE_MANAGER gate in every service.

Package PKG-46, release R6, severity HIGH.

Where. `users.role` is one tenant-wide column (user.entity.ts:108-114). Assigning a manager for a
single module wrote MODULE_MANAGER into it for every non-admin (tenant.service.ts:582-586). Token
minting copies it into `role` and `roles` and skips site assignments for it
(token.service.ts:368-371,593-598). The role hierarchy that every service's RolesGuard applies has
no module dimension.

Root cause. Manager status predates per-module grants. Each persisted row therefore grants manager
power in farm, HR, sensor and alerts at once, with no site restriction. PKG-06 removes the writer
and PKG-04 mints `moduleAccess`, but the existing rows remain. Any reader still using the global
role keeps giving a user who holds {farm: MODULE_MANAGER} manager power elsewhere, for example HR
unit writes.

Fix, tier 1+3.

- Migration DemoteGlobalModuleManagers turns non-admin MODULE_MANAGER users into MODULE_USER, logs
  counts per tenant and invalidates their tokens.
- The `no-global-role-authz` invariant then covers every service, so no new reader can appear.

Pinned by the migration spec (admins untouched, counts logged) and the invariant. Acceptance: no
user holds manager power through users.role.

Rule broken. In the section 2 target model and the PKG-02 decision table, users.role is an account
role only and the global role never grants module access

Evidence:

```text
apps/auth-service/src/modules/authentication/entities/user.entity.ts:108-114 (users.role is one tenant-wide role column)
apps/auth-service/src/modules/tenant/services/tenant.service.ts:582-586 (Assign Manager wrote MODULE_MANAGER into users.role for a single module)
apps/auth-service/src/modules/authentication/services/token.service.ts:368-371 (the access token carries users.role as role and roles)
apps/auth-service/src/modules/authentication/services/token.service.ts:593-598 (a global MODULE_MANAGER gets an empty site list, i.e. no site restriction)
libs/backend-common/src/decorators/roles.decorator.ts:82-86 (the role hierarchy has no module dimension)
apps/hr-service/src/hr/hr.resolver.ts:314-316 (for example, any global MODULE_MANAGER may update HR organisation units)
```

## FARM-MEDIUM-470

Defect. The farm-service common registry (sites, departments, suppliers, supplier sites,
consumables, finance categories and entries) has no owner-module key, so every row is implicitly
farm, sensor and HR read it as their own, and no read can be narrowed to a module grant nor a
cross-module link refused.

Package PKG-13, release R7, severity MEDIUM.

Where. farm-service owns the common kinds, and none of their tables has an owner-module column:
`sites` (site.entity.ts:139-145), `departments` (department.entity.ts:79-82), `suppliers`,
`supplier_sites`, `consumables` (consumable.entity.ts:51-54), `finance_categories` and
`finance_expense_entries`. Uniqueness is per tenant only.

Root cause. The registry began as farm setup data. Other modules then started reading it without a
key: sensor-module uses `sites` as its location list and hr-module reads `activeSites`. A sensor
or HR site can therefore exist only as an unlabelled farm row. Without a key:

- D1 cannot be expressed;
- a read cannot be narrowed to the caller's grants;
- the database cannot refuse a supplier link, department or ledger entry that points at another
  module's site.

Fix, tier 1 (impossible).

- A NOT NULL module column on the farm-owned enum `farm_registry_module_enum`.
- Composite (id, module) foreign keys.
- An immutability trigger.
- Partial unique indexes scoped by module.
- Reads become `scoped('common-registry')`, and reads by id use `assertRegistryRecordInScope`.

Pinned by `tests/invariants/common-kind-module-key.spec.ts` and a migration-harness spec on real
Postgres with FORCE RLS. The spec checks four things: legacy rows read as farm, a cross-module FK
fails, a module update raises an error, and relfilenode is unchanged.

Rule broken. D1 and the section 2 target model: common kinds (sites, site departments, suppliers,
consumables, module ledgers) are keyed by module with moduleCode NOT NULL and are read by holders
of that module's grant

Evidence:

```text
apps/farm-service/src/site/entities/site.entity.ts:139-145 (sites has no module column; code and name are unique per tenant only)
apps/farm-service/src/supplier/entities/supplier-site.entity.ts:35-38 (supplier-to-site link is keyed by ids alone; nothing ties the supplier and the site to one module)
apps/farm-service/src/finance/entities/finance-expense-entry.entity.ts:110-112 (ledger entry siteId is a bare nullable uuid with no module)
apps/farm-service/src/site/site.resolver.ts:167-176 (the sites list takes no module argument; only the global role and site assignment shape it)
web/modules/sensor-module/src/hooks/useLocationHierarchy.ts:52-54 (sensor-module lists the same farm sites as its own locations)
web/modules/hr-module/src/graphql/site-responsibility.operations.ts:18-20 (hr-module reads activeSites from the same registry)
```

## FARM-MEDIUM-471

Defect. The shared Site row types every site with a non-null aquaculture-only SiteType (default
land_based) and accepts farm-only regulatory and capacity attributes with no module rule, so the
registry sensor-module uses for its locations cannot describe a non-farm site truthfully.

Package PKG-14, release R7, severity MEDIUM.

Where. `Site` in farm-service is the one site row that every module reads.

- Its `type` is a non-null `SiteType` with six aquaculture facility kinds and a default of
  `LAND_BASED` (site.entity.ts:30-37,185-191).
- Farm-only attributes sit on the same row with no ownership rule: the Akvakulturregisteret
  `lokalitetsnummer`, `organisationNumberOverride`, `waterCapacityM3`, `maxBiomassKg`,
  `monitoringArea` and `facilities`.

Root cause. The type list and the attribute set were designed for aquaculture before D1 made sites
a common kind of each module. sensor-module already shows its locations through this `type`, so a
pump house or a control room is recorded as a land-based RAS. Once PKG-13 keys rows by module,
nothing would stop a sensor or HR site from carrying a fish-farm locality number or a biomass cap.

Fix, tier 1+3.

- `SITE_TYPES_BY_MODULE` (with no hydroponics entry) and a `siteTypePolicy` query.
- A type-guarded ADD VALUE for the new site types.
- A CHECK that requires the nullable farm-only columns to be empty on non-farm rows.
  `monitoringRadiusM` and `monitoringLocationRevision` are NOT NULL with defaults, so they stay
  outside the CHECK.

Pinned by the policy spec and a parity spec that keeps the CHECK, the policy and the column
nullability in agreement.

Rule broken. D1 makes sites a common kind of each module, and the decided default keeps the farm
regulatory identity farm-private

Evidence:

```text
apps/farm-service/src/site/entities/site.entity.ts:30-37 (SiteType lists six aquaculture facility kinds only)
apps/farm-service/src/site/entities/site.entity.ts:185-191 (type is NOT NULL with default LAND_BASED)
apps/farm-service/src/site/entities/site.entity.ts:176-183 (Akvakulturregisteret lokalitetsnummer and organisationNumberOverride sit on every site)
apps/farm-service/src/site/entities/site.entity.ts:272-290 (waterCapacityM3 and maxBiomassKg sit on every site)
apps/farm-service/src/site/dto/create-site.input.ts:101-118 (create input accepts those attributes and defaults type to LAND_BASED with no module policy)
web/modules/sensor-module/src/hooks/useLocationHierarchy.ts:10-16 (sensor-module's Site reads that aquaculture type for its locations)
```

## FARM-MEDIUM-472

Defect. Site and Department domain events carry no owner module in the TypeScript contract or the
strict wire schema, and the gateway bridge validates raw payloads without an upcast step, so
registry events cannot be routed by module and the field cannot be added without the bridge
dropping events.

Package PKG-16, release R7, severity MEDIUM.

Where. `SiteCreated/Updated/Deleted` and `DepartmentCreated/Updated/Deleted`
(farm-events.ts:582-648) name no module, and neither do their wire schemas. The schemas are strict
(`additionalProperties: false`). The gateway bridge runs `validateFarmEvent` on the raw payload
and applies no upcaster registry.

Root cause. The events were shaped while the registry was farm-only. Once rows are keyed by module
(PKG-13), a sensor site's creation looks the same as a farm site's. The gateway then cannot place
it in a module room (PKG-10's `t:{tenant}:registry:{module}`), and any consumer would have to read
the row back. The bridge neither accepts unknown fields nor upcasts. A producer that adds the
field before the bridge accepts it therefore has its events dropped, so C5 cannot be followed.

Fix, tier 1+3.

- PR1: the wire schema requires `moduleCode`, limited to the module dictionary. A v1→v2 upcaster
  maps v1 events to farm, which is truthful because v1 producers existed only while every row was
  farm. The bridge upcasts before it validates.
- PR2: the TypeScript interfaces require the field, so a producer cannot compile without it, and
  producers emit version 2.

Pinned by schema, upcaster, bridge and producer specs. No v1 event is produced after R7.

Rule broken. D1 keys registry rows by module, and contract rule C5 requires an event consumer to
ship before its producers, which the current unversioned contract cannot do

Evidence:

```text
libs/event-contracts/src/farm-events.ts:582-590 (SiteCreatedEvent has no module field)
libs/event-contracts/src/farm-events.ts:619-626 (DepartmentCreatedEvent has no module field)
libs/event-contracts/src/schemas/farm-events.schema.ts:682-685 (additionalProperties false: an unknown module field fails validation)
libs/event-contracts/src/schemas/farm-events.schema.ts:1508-1520 (siteCreatedSchema requires no module)
apps/gateway-api/src/websocket/farm-nats-bridge.service.ts:304 (validateFarmEvent runs on the raw payload; no upcaster registry is applied)
apps/farm-service/src/site/handlers/create-site.handler.ts:127-138 (the producer emits SiteCreated without a module)
```

## HR-MEDIUM-068

Defect. HR organisation units may have no owning module: departments_hr.moduleCode is nullable and
documented as company-wide, the enum has no hr value, the update input lets null clear it and the
web offers a company-wide option, so these units and their employees sit outside every module
slice.

Package PKG-18, release R7, severity MEDIUM.

Where. Five places allow a unit with no owning module:

- `departments_hr.moduleCode` is nullable and documented as company-wide
  (department.entity.ts:33-36).
- `HrModuleCode` has no `hr` value (enums.ts:32-41).
- The create input says to omit the module for a company-wide unit.
- The update input lets `null` clear it.
- DepartmentsPage offers a company-wide option and can move a unit back to it.

Root cause. The module-scoped HR change modelled "belongs to the whole company" as NULL, because
hr itself had no module value. D1 makes Company a read-only umbrella, not an owner, and D7 moves
NULL units to hr. Every module slice inner-joins on the unit's module (module-scope.ts:57-61).
Employees of a NULL unit therefore appear only in the unscoped view: no manager's slice and no hr
slice owns them.

Fix, tier 1.

- PR1 (R6): SET DEFAULT 'hr'; move NULL rows to hr, deleted ones included, with counts per schema;
  refuse null on update.
- PR2 (R7): re-run the backfill for rows written by old containers; SET NOT NULL and drop the
  default; make the entity and the GraphQL field non-null; require an active module on create;
  remove the web option.

Pinned by a migration-harness spec: live and deleted NULL rows become hr, and a replay changes
nothing. After R7, no schema holds a NULL moduleCode.

Rule broken. D7 moves HR departments with a NULL module to hr, and D1 makes Company a read-only
umbrella, not an owner of organisation units

Evidence:

```text
apps/hr-service/src/hr/entities/department.entity.ts:33-36 (moduleCode is nullable; null means company-wide)
apps/hr-service/src/common/enums.ts:32-41 (HrModuleCode is farm, hydroponics, sensor; there is no hr value)
apps/hr-service/src/hr/dto/create-department.input.ts:35-41 (the module is omitted for a company-wide department)
apps/hr-service/src/hr/dto/update-department.input.ts:14-17 (a null on a nullable field is a deliberate clear, moduleCode included)
apps/hr-service/src/common/module-scope.ts:57-61 (every module slice inner-joins on the unit's moduleCode)
web/modules/hr-module/src/pages/DepartmentsPage.tsx:91-93 (Company may move a department back to company-wide null)
```

## HR-MEDIUM-069

Defect. updateHRDepartment rewrites a unit's moduleCode while employees are placed in it, and
employees take their module only through their unit, so one edit silently moves every placed
employee into another module's slice without a duty request or HR approval.

Package PKG-18, release R7, severity MEDIUM.

Where. `UpdateDepartmentHandler` applies every input field, `moduleCode` included, with
`Object.assign` (update-department.handler.ts:74-76). It counts placed employees only for a soft
delete (58-68). Any global MODULE_MANAGER can call the mutation (hr.resolver.ts:314-316).

Root cause. An employee has no module of their own: every slice takes it from the employee's live
unit (module-scope.ts:4-8,57-61). Changing a unit's module therefore moves everyone in it at once,
with no approval. Re-tagging a farm unit as sensor moves its staff out of the farm manager's slice
and into the sensor manager's. This bypasses the D5 request-and-approve flow and leaves no record
per employee.

Fix, tier 1+3. A single owner for unit rules, `hr/services/department-rules.ts`, used by both
create and update. Under it, the module cannot change while live employees are placed in the unit.
The sibling rules from the same package are already registered as HR-LOW-057 and are linked, not
duplicated:

- a parent must be live and in the same module;
- siteId must be a live registry site, checked through the farm placement responder.

Pinned by the department-rules spec (a module change is refused while employees are placed and
allowed when the unit is empty) and the placement responder spec.

Rule broken. D5: module managers request duty inside their module and HR approves, so an
employee's module membership changes only through that approval

Evidence:

```text
apps/hr-service/src/hr/handlers/update-department.handler.ts:74-76 (every input field, moduleCode included, is applied with Object.assign)
apps/hr-service/src/hr/handlers/update-department.handler.ts:58-68 (placed employees are counted only for a soft delete, never for a module change)
apps/hr-service/src/common/module-scope.ts:4-8 (an employee has no module of their own, only a department)
apps/hr-service/src/common/module-scope.ts:57-61 (slices join on the unit's moduleCode)
apps/hr-service/src/hr/hr.resolver.ts:314-316 (updateHRDepartment is open to any global MODULE_MANAGER)
apps/hr-service/src/hr/dto/update-department.input.ts:48-51 (moduleCode is an ordinary optional update field)
```

## ALERT-HIGH-022

Defect. Escalation is module-blind: escalation policies and incidents carry no module, policy
matching uses severity, rule and farm only, and farm-signal incidents pass no farmId, so a policy
authored in the sensor workspace receives farm alarms and its suppression window silences them.

Package PKG-22, release R7, severity HIGH.

Where. alert-engine stores a module on `alert_history` but not on `escalation_policies` or
`alert_incidents`.

- `findMatchingPolicy` filters by severity, ruleId and farmId, and otherwise falls back to one
  tenant-wide default.
- `appliesTo` skips its farm filter when no farmId is given.
- Farm-signal incidents (mortality, FCR, water quality, feeding, stock) start escalation without a
  farmId.

Root cause. The escalation pipeline still treats the tenant as one alarm domain. Policies are
written in sensor-module's EscalationPoliciesPage, behind a global-role gate. A sensor-side policy
for CRITICAL therefore matches every CRITICAL farm incident:

- its recipients receive the farm rule name and batch id in the escalation message;
- its suppression window returns null for farm incidents, so a farm alarm is silently never
  escalated.

Fix, tier 1+3.

- PR1 (R6): rules and policies get `module NOT NULL DEFAULT 'sensor'`, which is accurate because
  rules evaluate only SensorReading. Policies are cloned for each alarm module. Incidents get a
  nullable column with a batched backfill.
- PR2 (R7): incidents go through CHECK NOT VALID → VALIDATE → SET NOT NULL, the defaults are
  dropped, and evaluation and escalation filter by module.

Pinned by specs proving that a farm incident never matches a sensor policy and that a rule written
by an old container is still evaluated, plus the backfill spec.

Rule broken. D4 makes alert module-scoped and D2 keeps module-private data unreachable from
another module, so an alarm may escalate only through its own module's policies

Evidence:

```text
apps/alert-engine/src/database/entities/escalation-policy.entity.ts:137-140 (escalation_policies has no module column)
apps/alert-engine/src/database/entities/alert-incident.entity.ts:85-89 (alert_incidents has no module column)
apps/alert-engine/src/escalation/escalation-policy.service.ts:203-227 (findMatchingPolicy filters by severity, ruleId and farmId, then falls back to one tenant-wide default)
apps/alert-engine/src/database/entities/escalation-policy.entity.ts:286-289 (the farm filter is skipped when farmId is absent)
apps/alert-engine/src/alert/services/farm-signal-incident.service.ts:186-187 (farm-signal incidents start escalation with no farmId and no module)
apps/alert-engine/src/escalation/escalation-manager.service.ts:281-287 (a matched policy's suppression window returns null: no escalation)
```

## ALERT-MEDIUM-023

Defect. The AlertTriggered event carries no module or siteId although alert-engine stores both on
the alarm's history row, and notification-service declares a private copy of the event instead of
importing the contract, so alarm notifications cannot be filtered by module and the two shapes
drift.

Package PKG-22, release R7, severity MEDIUM.

Where. `AlertTriggeredEvent` (alert-events.ts:30-45) has trigger fields but no module and no
siteId, although the producer writes both onto the same alarm's history row. notification-service
does not import the contract. It declares its own `AlertTriggeredEvent`
(alert-triggered.handler.ts:71-90) and takes only `EventId` from the library.

Root cause. The module was added to `alert_history` (migrations 1801200000000 and 1801300000000)
without bumping the event version, so every consumer downstream of NATS lost it. Because
notification-service keeps a private interface, a contract change neither breaks its compilation
nor reaches its upcasting, so the two shapes drift silently. Notification fan-out by module
(PKG-44) and the alarm pages per module (PKG-31) cannot filter on a field the event does not
carry.

Fix, tier 1+3.

- AlertTriggered v3 carries `module` and `siteId`, with a v2→v3 upcaster registered in the default
  registry.
- notification-service imports the shared type and upcasts before handling.
- Every alert_history writer is typed to set the module.

Pinned by the upcaster spec and a notification handler spec for v2 and v3 payloads. The single
event contract is then enforced by compilation.

Rule broken. D4 makes alert module-scoped, and event shapes have one owner in libs/event-contracts
(one concept, one owner)

Evidence:

```text
libs/event-contracts/src/alert-events.ts:30-45 (AlertTriggeredEvent has no module and no siteId)
apps/alert-engine/src/alert/services/alert-evaluation.service.ts:490-515 (the producer builds version 2 with trigger fields only)
apps/alert-engine/src/alert/entities/alert-history.entity.ts:73-83 (the same alarm's history row stores siteId and module)
apps/notification-service/src/notification/event-handlers/alert-triggered.handler.ts:71-90 (a local AlertTriggeredEvent interface duplicates the contract)
apps/notification-service/src/notification/event-handlers/alert-triggered.handler.ts:9 (only EventId is imported from the contracts library)
```

## FE-LOW-385

Defect. Site card View Details button in the farm Setup Sites tab navigates to /sites/:siteId,
which the farm remote only redirects back to the sites list, so the link is dead and never reaches
the site monitor.

Package PKG-27, release R7, severity LOW.

Where: farm-module `pages/setup/tabs/SitesTab.tsx` and the farm remote's route table.

Root cause: the site detail page was removed and its route became a redirect back to
`/sites/setup/sites`, but the site card's View Details button still navigates to
`/sites/${site.id}`. A click therefore remounts the list it came from. The site monitor that does
show a site (`environment/:siteId`) exists but is not linked. The nav invariant's dead-link rule
covers nav entries, tabs and patterns only, so an in-page link to a redirect source is not
detected.

Fix tier: 1. The button links to the site monitor route for that site.

Pinned by: a SitesTab spec asserting that the button's destination is the environment route for
the site, so a link back to a redirect source fails the spec.

Rule broken. The console navigation contract (FE-HIGH-334/335: every link names a real page, never
a redirect hop) is broken by an in-page link.

Evidence:

```text
web/modules/farm-module/src/pages/setup/tabs/SitesTab.tsx:445 (View Details navigates to /sites/${site.id})
web/modules/farm-module/src/Module.tsx:152-154 (the :siteId route is a Navigate back to /sites/setup/sites; the detail page was removed)
web/modules/farm-module/src/Module.tsx:146-147 (the site monitor route environment/:siteId exists and is not linked)
tests/invariants/web-console-nav-coverage.spec.ts:21-23 (the dead-link rule covers nav entries, tabs and patterns only, not in-page links)
```

## FE-MEDIUM-382

Defect. Company workspace lists module-private farm and sensor pages (sites, storage locations,
facility structure, farm ledger charts, categories and settings, Edge Devices and a raw Database
browser over sensor, farm and HR tables), so the D2 boundary is crossed in the console itself.

Package PKG-27, release R7, severity MEDIUM.

Where: `web/shell/src/console/nav/workspaces/org.ts` (Company) and the tenant-admin remote.

Root cause: the console nav was drawn as a design tree with no access layer per page, so Company
became the home of every page that looked tenant-wide. It lists farm registry and production pages
(sites, storage locations, facility structure, workers), the farm ledger's charts, categories and
settings tabs, a second copy of the sensor edge-device pages, and a Database browser whose table
map spans the sensor, farm and hr schemas, `payrolls` included. Each route keeps its own gate, but
the Company layer itself presents module-private data. That breaks D2 at the surface and makes a
Company-only viewer (role B) impossible to define. The workforce and pay area is excluded here
because PKG-26 owns it.

Fix tier: 1. The pages move to Production and Control & sensors. The Database page reads through
the sensor readers. The tenant-admin edge-device copies are deleted once parity with the sensor
pages is confirmed (parity is UNVERIFIED).

Pinned by: a definitions spec asserting that Company lists no `/sites`, `/sensor` or raw-table
page. Later, the PKG-34 `layer` type makes such a listing a compile error.

Rule broken. D2: module-private data must not be reachable from Company through the UI, and plan
section 2 places farm registry, storage, ledger and sensor devices and raw tables in their module
layers.

Evidence:

```text
web/shell/src/console/nav/workspaces/org.ts:42-50 (Company finance area lists the farm ledger tabs charts, categories and settings, which no production workspace lists)
web/shell/src/console/nav/workspaces/org.ts:86-107 (Company facility area lists farm registry and production pages: sites, storage locations, departments, workers, facility structure, suppliers, consumables)
web/shell/src/console/nav/workspaces/org.ts:117 (Company access group lists TN.devices and TN.database)
web/modules/tenant-admin/src/pages/TenantDatabase.tsx:49-127 (Database page maps sensor, farm and hr tables, including sensor_readings and payrolls)
web/modules/tenant-admin/src/Module.tsx:114-115 (second copy of the edge-device list and detail pages, beside sensor-module's /sensor/devices/edge routes)
web/shell/src/console/data/useConsoleDataAccess.ts:50 (sensor-service edge devices are fetched for a tenant admin without the sensor module)
```

## FE-MEDIUM-383

Defect. Console nav tenantWide flag presents the farm-service regulatory-settings editor
(/sites/company) as the Company record and exempts it from the farm module gate for tenant admins,
so the Company identity is a writable farm-private record.

Package PKG-27, release R7, severity MEDIUM.

Where: `pages/farmSetup.ts`, `types.ts` and `pageAccess.ts` in the console nav, and farm-module
`CompanyPage.tsx`.

Root cause: the Company record was built as the farm-service regulatory settings page (company
name, organisation number and address, with an update mutation). A nav flag, `tenantWide`, was
then added so that a tenant admin sees it whatever modules the tenant holds. The flag is a
per-page exception to the module gate, not a layer. It makes a farm-private, writable regulatory
record the identity of the read-only Company layer, and a tenant without farm still gets a
farm-remote page as its Company record.

Fix tier: 1. The page becomes a Production Setup tab (RegulatoryTab). `tenantWide` is deleted from
the type and from the gate, so no page can opt out of its module gate again. The Company identity
is served from the auth tenant record through the PKG-33 projection.

Pinned by: RegulatoryTab error and read-only specs. Because the nav type no longer carries the
flag, reintroducing it fails to compile.

Rule broken. Plan section 2 decided default: the Company identity is the auth tenant record, the
farm regulatory identity stays farm-private, and the Company layer is read-only.

Evidence:

```text
web/shell/src/console/nav/pages/farmSetup.ts:13-14 (farm remote page /sites/company declared tenantWide: true as the tenant-wide company record)
web/shell/src/console/nav/types.ts:113-118 (tenantWide documented as a tenant-wide record served by a module remote)
web/shell/src/console/nav/pageAccess.ts:29-30 (module gate skipped for a tenant admin when tenantWide is set)
web/modules/farm-module/src/pages/company/CompanyPage.tsx:22-39 (page reads and mutates farm regulatorySettings: company name, organisation number, address)
web/shell/src/console/nav/workspaces/org.ts:94 (listed as the first entry of the Company facility area)
```

## FE-MEDIUM-384

Defect. Farm Setup and Storage in-page tab strips are split across two console workspaces (Sites
and Storage Locations only in Company; Systems, Equipment, Species and stock tabs only in
Production), so clicking a tab moves the rail to another workspace and no invariant detects it.

Package PKG-27, release R7, severity MEDIUM.

Where: farm-module `SetupPage.tsx` and `StoragePage`, the nav definitions, and
`workspaceForPath.ts`.

Root cause: the Setup page renders one tab strip and the Storage page another, but the console
placed their tabs one at a time into different workspaces. Sites, Storage Locations and the other
registry tabs sit in Company. Systems, Equipment, Species and the stock tabs sit in Production.
The rail follows the workspace that claims a path most strongly, so a click on an in-page tab
switches the user's workspace. The Setup index even redirects to `sites`, which only Company
claims. The coverage invariant checks reachability, dead entries, gates and redirects, but no rule
covers a strip spanning workspaces, so this drift is neither impossible nor detected.

Fix tier: 3 for detection: invariant rule 7 requires every tab of one in-page strip to resolve to
the same workspace. Tier 1 for placement: the registry and storage tabs move to Production.

Pinned by: rule 7 in `tests/invariants/web-console-nav-coverage.spec.ts`, red on today's
definitions and green after. Acceptance: clicking a Setup tab never changes the workspace.

Rule broken. Plan rule 7 (an in-page tab strip never spans workspaces) and the repo hierarchy
impossible &gt; automatic &gt; detectable: this drift is neither impossible nor detected.

Evidence:

```text
web/modules/farm-module/src/pages/setup/SetupPage.tsx:51-144 (one tab strip: Sites, Departments, Systems, Equipment, Structure, Species, Suppliers, ..., Workers)
web/shell/src/console/nav/workspaces/org.ts:93-100 (Sites and Storage Locations are listed only in Company)
web/shell/src/console/nav/workspaces/aqua.ts:65-74 (Production lists Systems and Equipment but not Sites)
web/shell/src/console/nav/pages/farmOperations.ts:84-103 (Production's storage strip lacks the locations tab, which is a separate Company entry)
web/shell/src/console/nav/workspaceForPath.ts:41-63 (the rail moves to the workspace that claims the path most strongly)
tests/invariants/web-console-nav-coverage.spec.ts:16-31 (rules 1-6; none forbids an in-page strip spanning workspaces)
```

## FE-MEDIUM-386

Defect. Table-to-module ownership on the tenant database page is guessed by three hand-maintained
maps (auth inferModuleFromTableName substring matching and two web lists) instead of
MODULE_SCHEMAS, mislabelling farm departments as hr and farm tasks as project and advertising hr
payrolls as a browsable table.

Package PKG-45, release R7, severity MEDIUM.

Where. The tenant database page labels and groups tables by module from three sources that are not
the registry. auth-service's `inferModuleFromTableName` matches substrings. The web keeps
`MODULE_TABLES` in `TenantDatabase.tsx` and a second `tables` list per module in
`lib/constants.ts`.

Root-cause chain. Ownership is retyped instead of derived from `MODULE_SCHEMAS`, so the copies
drift. Farm's `departments` is labelled hr, farm's `tasks` is labelled project, and labels exist
for modules the platform does not have (crm, inventory, finance). Both web lists advertise hr
`payrolls` as a browsable table next to farm and sensor tables, which invites exactly the
cross-module raw read that D6 forbids. Nothing fails when a service adds or renames a table.

Fix tier. 1: the hand-maintained maps are deleted, and any surviving table listing is derived from
the owning service's registry entry. 3: the dictionary SSoT invariant flags a retyped
module-to-table list.

Pinned by. A web spec that the database page renders only registry-derived, sensor-owned tables,
and an invariant that no web file declares a module table list.

Rule broken. Repo rule of one owner per fact (MODULE_SCHEMAS owns which module a tenant table
belongs to) with hierarchy impossible &gt; automatic &gt; detectable.

Evidence:

```text
apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:1356 (a substring map: 'departments' maps to hr, 'tasks' to project, plus modules that do not exist such as crm and inventory, :1356-1380)
apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:1206 (every listed table's module label comes from that guess)
web/modules/tenant-admin/src/pages/TenantDatabase.tsx:49 (first hand-maintained module-to-tables map; it lists hr payrolls at :127)
web/modules/tenant-admin/src/lib/constants.ts:64 (a second hand-maintained copy of the same table lists, including payrolls)
libs/backend-common/src/database/schema-manager.service.ts:255 (MODULE_SCHEMAS already owns the per-module table lists)
apps/farm-service/src/department/entities/department.entity.ts:79 (farm owns the table departments, which the guess labels hr)
```

## SEC-HIGH-210

Defect. auth-service tableData, tableSchema, tenantTables and tenantDatabase implement a generic
SELECT reader over the dedicated tenant schema, which holds every tenant-aware service's tables
including payrolls and messages, with no table allowlist, so the D6 and messaging boundaries rest
only on auth_service database grants.

Package PKG-45, release R7, severity HIGH.

Where. In auth-service, `TenantAdminResolver.tableData`, `tenantTables` and
`TenantResolver.tableSchema`/`tenantDatabase` give SUPER_ADMIN and TENANT_ADMIN a schema browser.
`getTableData` allows the dedicated tenant schema plus the enabled module schemas, then runs
`SELECT * … LIMIT … OFFSET` with no table allowlist, and with no row filter on the dedicated
schema.

Root-cause chain. The provisioner replays every tenant-aware service (farm, sensor, hr, messaging,
alert, ai, hydroponics) into one tenant schema. auth-service owns none of those tables, yet its
code reads all of them raw: `payrolls` would return plaintext salary outside hr-service, and
`messages` would return direct-message content that messaging serves only to channel members. The
only barrier is the database grant set. The bootstrap SQL gives auth_service no tenant-schema
access, so on a correctly granted database the page is a dead reader; on any grant drift it is a
payroll and DM reader. Table names and row counts leak either way.

Fix tier. 1: the generic reader is deleted, and the only raw-table reader is a sensor-owned one
over a closed allowlist. 3: an invariant forbids auth-service SQL naming an hr or farm table.

Pinned by. An allowlist spec, and an access-matrix row proving payrolls cannot be read through any
database page.

Rule broken. D6 (salary and HR finance are visible only inside HR) and D2, plus the repo rule that
each service owns its tables: no generic SQL reader over tenant schemas may exist outside the
owning service.

Evidence:

```text
apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts:84 (tableData, and tenantTables at :73, are exposed to TenantAdminOrHigher)
apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:1255 (allowed schemas are the dedicated tenant schema plus enabled module codes; there is no table allowlist)
apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:1326 (SELECT * with no row filter on the dedicated tenant schema)
apps/db-migrate/src/tenant-schema-provisioner.ts:966 (every tenant-aware service's migrations are replayed into the one tenant schema, :962-977)
apps/hr-service/src/hr/entities/payroll.entity.ts:161 (payrolls stores earningsBaseSalary as a plain decimal)
apps/auth-service/src/modules/tenant/services/tenant.service.ts:290 (tenantDatabase reads pg_tables and pg_stat_user_tables, listing every module table's name, row count and size regardless of grants)
```

## FARM-MEDIUM-473

Defect. Finance categories and finance events encode the owning module inside a hand-written
ledger scope (FARM_OPEX, FARM_REVENUE, HR_EXPENSE) kept in copies that disagree, uniqueness is
keyed on it, and the farm delete handler fabricates FARM_OPEX when its category lookup misses.

Package PKG-15, release R8, severity MEDIUM.

Where. Finance categories carry `scope` (`FARM_OPEX` or `FARM_REVENUE`). It is a NOT NULL column
with its own Postgres enum, and code and name uniqueness are keyed on it
(CreateFinanceTables.ts:160-168). The finance event contract keeps a wider copy that adds
`HR_EXPENSE`, and hr-service publishes its ledger events on that same contract.

Root cause. Before any module key existed, the ledger label also served as the owner. The
`FARM_`/`HR_` prefix is a second module vocabulary outside the module dictionary, kept by hand in
three places: the entity enum, the event union and the wire schema. When PKG-13 adds `moduleCode`
to the finance tables, the two owner fields can disagree. The delete handler already hides a
missing category by inventing `FARM_OPEX` instead of failing.

Fix, tier 1.

- `scope` gets DROP NOT NULL and is unmapped, so it becomes an orphan column (C4).
- Uniqueness is rebuilt on the module key, with the new indexes built CONCURRENTLY.
- Finance events move to v2, with an upcaster.
- The fallback disappears together with the field.

Pinned by the finance upcaster spec and `tests/invariants/farm-private-common-kind-scope.spec.ts`.
The column itself is dropped in R13 (PKG-38).

Rule broken. Module ownership is declared once, in the PKG-01 module dictionary (one concept, one
owner), and the repo rule bans defensive optional chaining and fallbacks

Evidence:

```text
apps/farm-service/src/finance/entities/finance-category.entity.ts:37-40 (FinanceCategoryScope bakes the module prefix into a ledger label; two values)
apps/farm-service/src/finance/entities/finance-category.entity.ts:98-104 (scope is a NOT NULL column with its own Postgres enum)
apps/farm-service/src/database/migrations/1804600000000-CreateFinanceTables.ts:160-168 (code and name uniqueness keyed by tenantId + scope)
libs/event-contracts/src/finance-events.ts:38 (the event union is a wider copy that adds HR_EXPENSE)
apps/hr-service/src/finance/handlers/hr-finance-entry.handlers.ts:106 (hr-service publishes HR_EXPENSE on the same finance event contract)
apps/farm-service/src/finance/handlers/delete-finance-entry.handler.ts:58 (category?.scope ?? 'FARM_OPEX' invents a scope instead of failing)
```

## HR-HIGH-070

Defect. HR has no record of module duty: an employee's module is the single departmentHrId
pointer, so an employee can serve at most one module, and a module change overwrites the pointer
in place with no request, no HR approval and no history.

Package PKG-19, release R8, severity HIGH.

Where: hr-service derives module membership only from `employees.departmentHrId` →
`departments_hr.moduleCode` (module-scope.ts:4-8, employee.entity.ts:321-324).

Root cause: duty in a module was modelled as a property of the one organisation unit an employee
sits in, not as its own record. As a result:

- An employee on duty in both farm and sensor cannot be represented.
- A move is an `Object.assign` over the department id (update-employee.handler.ts:102-104), so the
  earlier module placement disappears without trace.
- The only placement rule (assignable-department.ts:29-41) checks that the unit is live. It never
  checks who is asking or whether HR approved, and `updateEmployee` is open to every
  MODULE_MANAGER (hr.resolver.ts:171-182).

The D5 request-and-approve flow therefore has nowhere to live.

Fix (tier 1+2+3):

- Tier 1: an hr-owned `hr_employee_module_assignments` table with PENDING, APPROVED, REJECTED and
  CANCELLED states, CHECKs, partial unique indexes and RLS. The database rejects a PENDING row
  created by HR, and only HR can approve a request.
- Tier 2: placing an employee in a unit and terminating an employee maintain the rows in the same
  transaction.
- Tier 3: every manager lookup is audited.

Pinned by: a state-machine spec, the handler specs, a migration-harness spec (seed, CHECKs,
replay) and a tenant-erasure spec on the hr schema.

Rule broken. D5 (HR adds employees, module managers request duty inside their module, and HR
approves) has no representation in the hr-service data model.

Evidence:

```text
apps/hr-service/src/common/module-scope.ts:4-8 (an employee has no module of their own, only one department, and membership is asked through it)
apps/hr-service/src/hr/entities/employee.entity.ts:321-324 (departmentHrId is one nullable uuid and the only module link an employee has)
apps/hr-service/src/hr/dto/create-employee.input.ts:180-187 (documents 'the employee's one department; through it the employee belongs to a module')
apps/hr-service/src/hr/handlers/update-employee.handler.ts:102-104 (Object.assign then save: the previous module placement is overwritten with no request state and no history)
apps/hr-service/src/hr/services/assignable-department.ts:29-41 (the only placement rule checks that the department is live, never the caller's module or an HR approval)
apps/hr-service/src/hr/hr.resolver.ts:171-182 (updateEmployee is open to every MODULE_MANAGER, so any manager can move any employee between modules)
```

## AISAFETY-MEDIUM-037

Defect. The general AI persona, which belongs to no module, carries the farm water-chemistry and
reagent-dosing calculators, and every water-chemistry, aquaculture-math and sensor-config tool is
declared module-less, so any AI user without a farm or sensor grant is offered farm and sensor
domain tools.

Package PKG-23, release R8, severity MEDIUM.

Where:

- GENERAL_SPECIALTY (general.specialty.ts:9-23) has `requiresModule: null` and bundles seven
  water-chemistry and reagent-dosing tools. Its prompt tells it to answer sensor questions.
- Those tools, the aquaculture-math tools and the sensor-config tools all declare `requiresModule:
null` (for example calculate-reagent-dosing.tool.ts:100 and analyze-sensor-data.tool.ts:132).
  tool.interface.ts:41-46 defines null as "core".
- The module filter at agent-profile.service.ts:151-153 therefore lets them through for every
  persona.
- The general persona requires only the tier capability (persona-catalogue.ts:256-259).

Root cause: AiSpecialtyModule can only say `farm` (persona-catalogue.ts:48-49). The farm-domain
calculators and the sensor tools had no owner to name, so they defaulted to core. Any caller
holding an AI tier capability, including a Company-only viewer or an HR user, is offered reagent
dosing. These tools compute only on inputs the caller supplies and read no tenant data, so this is
an ownership gap, not a data exposure.

Fix (tier 1+2+3):

- Tier 1: add the sensor-control and hr-workforce specialties, assign every tool its owning
  module, and limit the general persona to core tools.
- Tier 2: a turn's module derives from the persona's specialty.
- Tier 3: an ownership invariant.

Pinned by: the catalogue spec and tests/invariants/ai-tool-module-ownership.spec.ts (no persona
runs another module's tools).

Rule broken. Under D2 and D4, AI is module-scoped and farm-domain capability must not be reachable
without a farm grant; the general persona belongs to no module.

Evidence:

```text
apps/ai-service/src/agent/personas/specialties/general.specialty.ts:9-23 (the general specialty has requiresModule null, bundles seven water-chemistry and dosing tools, and is told to answer sensor questions)
apps/ai-service/src/tools/water-chemistry/calculate-reagent-dosing.tool.ts:100 (the reagent dosing calculator declares requiresModule: null)
apps/ai-service/src/tools/sensor-config/analyze-sensor-data.tool.ts:132 (the sensor analysis tool is module-less as well)
apps/ai-service/src/tools/core/tool.interface.ts:41-46 (requiresModule null is defined as a core tool)
apps/ai-service/src/agent/agent-profile.service.ts:151-153 (the module filter rejects only tools with a non-null module, so module-less tools pass for every persona)
libs/shared-contracts/src/ai/persona-catalogue.ts:48-49 (AiSpecialtyModule can only be 'farm', so sensor or hr ownership cannot be expressed)
```

## AISAFETY-MEDIUM-038

Defect. AI behaviour configuration is one row per tenant: tenant_agent_configs holds a single
custom system prompt, tool additions, tool blocks and actuation policy that apply to every persona
of every module, so tuning the assistant for one module silently changes it for all others.

Package PKG-24, release R8, severity MEDIUM.

Where:

- TenantAgentConfig is unique on tenantId (agent-config.entity.ts:28-29). It carries the behaviour
  columns additionalToolNames, blockedToolNames, actuationPolicy and customSystemPrompt (78-88).
- getConfig reads it by tenantId alone (agent-config.service.ts:59-60).
- AgentProfileService applies the same row to whichever persona runs: tool additions and blocks
  (agent-profile.service.ts:118-129), the actuation policy (132-135) and the custom prompt for
  every user persona (178-181).

Root cause: the config predates the module specialists and was keyed by tenant only. As a result:

- a farm-oriented custom prompt is injected into sensor and HR conversations;
- blocking a tool or tightening actuation for farm changes every module;
- whoever holds `ai_settings:manage` (agent-config.resolver.ts:167) edits every module's assistant
  at once.

Fix (tier 1+2+3):

- Tier 2: a new `module_agent_configs` entity keyed by (tenant, module). The farm row copies
  today's settings and the other modules get defaults, with the counts logged.
- Tier 1: the behaviour columns of tenant_agent_configs are unmapped (orphan first, dropped in
  PKG-40), so a tenant-wide behaviour setting can no longer be read.
- Tier 3: the logged copy counts.

Pinned by: the config spec and a migration-harness spec for the copy, its counts and a replay.

Rule broken. D4 makes ai module-scoped, and plan PKG-24 requires AI behaviour to be configured per
module, not per tenant.

Evidence:

```text
apps/ai-service/src/tenant-config/agent-config.entity.ts:28-29 (tenant_agent_configs is unique on tenantId: one behaviour row per tenant)
apps/ai-service/src/tenant-config/agent-config.entity.ts:78-88 (additionalToolNames, blockedToolNames, actuationPolicy and customSystemPrompt live on that row)
apps/ai-service/src/tenant-config/agent-config.service.ts:59-60 (the config is read by tenantId alone, with no module)
apps/ai-service/src/agent/agent-profile.service.ts:118-129 (tenant tool additions and blocks are applied to whichever persona runs)
apps/ai-service/src/agent/agent-profile.service.ts:132-135 (one tenant actuation policy is merged into every persona)
apps/ai-service/src/agent/agent-profile.service.ts:178-181 (the single custom prompt is injected into every user persona)
```

## HR-MEDIUM-071

Defect. HR module membership has two competing definitions: module slices read the live
department's moduleCode while site slices and the employees farmId filter read employees.farmId,
neither reflects HR-approved duty, and one person can be inside a site slice yet outside that
module's slice.

Package PKG-20, release R9, severity MEDIUM.

Where:

- module-scope.ts calls itself the one definition of membership (module-scope.ts:2-8). It joins
  the live department (40-43, 50-62) and is imported by 13 non-test handlers.
- Site scoping bypasses it: get-weekly-plans.handler.ts:50-52 and
  get-team-weekly-overview.handler.ts:145-147 filter on `employees.farmId`.
- get-employees.handler.ts:30-36 applies both predicates side by side.
- The web Today site chips are built on the farmId reading (SiteFilterChips.tsx:4-6).

Root cause: `farmId` is a free column from before departments carried a module. It was never
retired as a membership key, so two predicates answer "who belongs here". For example, an employee
placed in an hr-module unit but carrying a farm farmId appears in that farm site's weekly plan,
but not in the farm module slice. Nothing reconciles the two.

Fix (tier 1+3):

- Tier 1: one `module-membership.ts` predicate replaces both. It is an EXISTS over APPROVED,
  currently effective assignment rows, and farmId is no longer read. An idempotent re-seed runs
  before the swap.
- Tier 3: the parity delta is reported and reviewed.

Pinned by: a membership spec, a parity spec that asserts the reported delta, and
tests/invariants/hr-module-membership-ssot.spec.ts, which forbids any other membership predicate.

Rule broken. Plan PKG-20 and the repo single-source-of-truth rule require one definition of module
membership (D5: a module manager sees only their slice).

Evidence:

```text
apps/hr-service/src/common/module-scope.ts:2-8 (declares itself the one definition of module membership, through the live department)
apps/hr-service/src/common/module-scope.ts:40-43 (membership is departments_hr.moduleCode with isDeleted false; there is no notion of approved duty)
apps/hr-service/src/scheduling/query-handlers/get-weekly-plans.handler.ts:50-52 (the site slice filters employee.farmId, a second membership key)
apps/hr-service/src/scheduling/query-handlers/get-team-weekly-overview.handler.ts:145-147 (the team overview site slice also reads e.farmId)
apps/hr-service/src/hr/query-handlers/get-employees.handler.ts:30-36 (the employees list applies the department-module predicate and the farmId predicate side by side)
web/modules/hr-module/src/pages/today/SiteFilterChips.tsx:4-6 (the Today site chips rely on teamWeeklyOverview matching employees.farmId)
```

## FARM-MEDIUM-474

Defect. Site deletion checks only farm-service's own tables: the delete preview and the delete
command ignore sensors, HR units and user site assignments that other services hold against the
site, so a site with live sensors or assigned users is deleted and leaves dangling references.

Package PKG-21, release R9, severity MEDIUM.

Where:

- get-site-delete-preview.handler.ts:47-89 counts departments, systems, tanks and equipment inside
  the farm schema only.
- delete-site.handler.ts:61-66 blocks only on farm departments (and on active biomass when
  cascading), then soft-deletes the site (167-172).
- Site ids are also held by sensor-service (sensor.entity.ts:236, plus edge devices, PLC
  connections and processes), by hr-service units (department.entity.ts:31) and by auth user site
  assignments (user-site-assignment.entity.ts:38-41,66, deliberately without an FK).
- The only SiteDeleted consumer is the gateway socket broadcast
  (farm-nats-bridge.service.ts:399-400).

Root cause: cross-service references cannot use FKs, and no census contract replaces them, so the
owner deletes blind. As a result:

- sensors keep reporting against a deleted site;
- MODULE_USERs keep a site assignment for a site that no longer exists;
- HR units point at nothing.

Fix (tier 1+3):

- A `site-reference-queries` NATS contract with count-only responders in sensor, hr and auth. The
  responders ship one release before the callers (C5).
- Tier 1: the delete is refused when open assignments or active sensors exist, or when the census
  is unavailable, so a blind delete becomes impossible.
- Tier 3: the counts are shown in the preview.

Pinned by: guard specs (refusal with counts, refusal when the census times out) and responder specs.

Rule broken. Plan PKG-21 requires that deleting a site show and respect references held by other
services. The registry owner must not orphan cross-service references it cannot see (ADR 052).

Evidence:

```text
apps/farm-service/src/site/handlers/get-site-delete-preview.handler.ts:47-89 (the preview counts only farm-schema departments, systems, tanks and equipment)
apps/farm-service/src/site/handlers/delete-site.handler.ts:61-66 (a non-cascade delete is blocked only by farm departments)
apps/farm-service/src/site/handlers/delete-site.handler.ts:167-172 (the site is soft-deleted without asking sensor, hr or auth)
apps/sensor-service/src/database/entities/sensor.entity.ts:236 (sensors hold a farm site id that survives the delete)
apps/auth-service/src/modules/authentication/entities/user-site-assignment.entity.ts:38-41 (user site assignments hold farm site ids, deliberately without an FK)
apps/gateway-api/src/websocket/farm-nats-bridge.service.ts:399-400 (the only SiteDeleted consumer is a socket broadcast; no owning service reacts)
```

## FE-MEDIUM-387

Defect. The web picks the workforce slice from client state rather than the URL: the same /hr/
pages are mounted in the farm, greenhouse, sensor and Company workspaces, the slice comes from
whichever workspace the shell follows, and an absent provider or the Company workspace means every
module.

Package PKG-28, release R9, severity MEDIUM.

Where:

- teamArea lists the same HR pages (/hr/today, /hr/scheduling, /hr/leaves, /hr/employees,
  departments, organisation chart) in every module workspace (shared.ts:48-63, mounted by
  aqua.ts:51, gh.ts:39 and ctl.ts:82).
- Company lists them again with no scope (org.ts:52-61).
- For a page that several workspaces share, useFollowedWorkspace keeps the stored workspace
  (useFollowedWorkspace.ts:5-7).
- ConsoleShell turns that workspace into a scope (ConsoleShell.tsx:129, provider at 260-262), and
  the HR hooks send `explicit ?? workspace ?? undefined` (useModuleScope.ts:19-21).
- The context default is null, meaning every module (WorkforceScopeContext.tsx:10-11,32), and the
  server reads an absent moduleCode as no scope (apps/hr-service/src/common/module-scope.ts:15).

Root cause: the slice is ambient UI state, not part of the route. As a result:

- the same URL lists different people depending on the last workspace;
- a deep link or a refresh can change the slice;
- any render outside the provider asks for everyone.

Fix (tier 1+3):

- Tier 1: HR owns /team/farm and /team/sensor through a TeamModule. The base path names the slice,
  useWorkforceAuthority derives it, and workforceScope.ts and the ConsoleShell provider are
  deleted.
- Tier 3: an invariant on the base path.

Pinned by: the TeamModule, authority and ProtectedRoute specs, and
tests/invariants/hr-module-base-path.spec.ts.

Rule broken. Plan PKG-28 and contract rule C2: the URL picks the slice, the server enforces it,
and a client module argument only narrows a scope the server derives (D5: a module manager sees
only their slice).

Evidence:

```text
web/shell/src/console/nav/workspaces/shared.ts:48-63 (teamArea lists the same /hr/* pages for every module workspace; it is mounted by aqua.ts:51, gh.ts:39 and ctl.ts:82)
web/shell/src/console/nav/workspaces/org.ts:52-61 (Company lists the same HR pages again as the all-modules view)
web/shell/src/console/shell/useFollowedWorkspace.ts:5-7 (a page the current workspace shares keeps the stored workspace, so the URL does not decide the slice)
web/shell/src/console/ConsoleShell.tsx:129 (workforce scope = workforceScopeOf(followed workspace), provided to the routed page at 260-262)
web/shared-ui/src/contexts/WorkforceScopeContext.tsx:32 (the context default is null, documented at 10-11 as every module)
web/modules/hr-module/src/hooks/useModuleScope.ts:19-21 (requests send explicit ?? workspace ?? undefined, and undefined means everyone)
```

## FE-MEDIUM-388

Defect. Common-registry management (sites, site departments, suppliers, consumables) exists only
in the farm remote under the farm-gated /sites mount, so the sensor and HR workspaces cannot
maintain the sites they reference and HR's site-contact link sends members without farm to
/unauthorized.

Package PKG-30, release R9, severity MEDIUM.

Where: the shell route table, farm-module Setup, and the sensor and HR remotes.

Root cause: the registry UI (sites, site departments, suppliers, consumables) was built inside the
farm remote as farm setup tabs and mounted under `/sites/*`, which requires the farm module.
Sensor reads the same registry for its location hierarchy, and HR's Today page sends users to the
farm Sites tab to fix site contacts. Neither workspace has a page of its own for these kinds. A
member without farm hits `/unauthorized`, and a tenant without farm sees no registry entry in the
nav at all. D1 makes these the common kinds of every owner module, so today they are owned by the
wrong surface.

Fix tier: 1. One set of registry components takes a required module prop and is mounted per module
(`/registry/sensor/*`, `/registry/hr/*`), with no copies. This depends on PKG-15 opening registry
writes to non-farm modules.

Pinned by: component specs asserting that every registry request carries the module. Acceptance: a
sensor site never appears in Production. Whether farm-service accepts registry writes for a tenant
without farm today is UNVERIFIED.

Rule broken. D1: Company is the umbrella over the common kinds of each module, so each owner
module must own and manage its own sites, departments, suppliers and consumables.

Evidence:

```text
web/shell/src/App.tsx:112-115 (/sites/* is mounted behind ProtectedRoute requiredModule="farm")
web/modules/farm-module/src/pages/setup/SetupPage.tsx:51-58 (registry tabs hard-wired to farm: 'Manage farm locations and sites')
web/modules/sensor-module/src/hooks/useLocationHierarchy.ts:52-55 (sensor reads registry sites but has no page to create or edit them)
web/modules/hr-module/src/pages/today/UnassignedSitesPanel.tsx:13-14 (HR Today sends users to the farm Sites tab to fix site contacts)
web/shell/src/console/nav/workspaces/ctl.ts:56-72 (Control & sensors configuration area has no registry entry)
```

## ALERT-MEDIUM-024

Defect. HR CertificationExpired events are published by hr-service but consumed by no service, and
AlertModule has no HR value, so an expired employee certification raises no alarm anywhere.

Package PKG-31, release R9, severity MEDIUM.

Where: hr-service `training/certification-expiry.service.ts` and alert-engine.

Root cause: HR-HIGH-012 made the expiry job publish `CertificationExpired` after commit so
consumers would see consistent state, but no service consumes it. A repository-wide search over
apps and libs finds the event only in its producer and its contract, and alert-engine's handlers
cover farm and sensor signals only. `AlertModule` has no HR value, so even a handler could not
file an HR alarm. An expired mandatory certification, such as one behind sea-worthiness, therefore
produces no alarm, no badge and no escalation.

Fix tier: 2. A new alert-engine handler turns each `CertificationExpired` event into an HR alarm,
idempotent per source event, after PKG-01 adds the `hr` value.

Pinned by: a handler spec (one alarm per event id; a replay creates none) and the HR alarm page
spec. `MandatoryTrainingOverdue` stays out because it has no producer.

Rule broken. Plan section 2 decided default (HR alarms come from CertificationExpired) and D4
(alert is module-scoped across the owner modules, hr included).

Evidence:

```text
apps/hr-service/src/training/certification-expiry.service.ts:122-138 (event published after commit 'so consumers see consistent state')
libs/event-contracts/src/hr-events.ts:200-201 (CertificationExpiredEvent contract)
infrastructure/nats/services.yaml:603 (hr_service publishes events.*.CertificationExpired)
apps/alert-engine/src/alert/entities/alert-module.enum.ts:12-25 (alarm sources are farm and sensor only; the enum has no HR value)
```

## FE-MEDIUM-389

Defect. Console alarm list is one sensor-module page (/sensor/alerts) shared by every module
workspace and requests alertHistory without a module, so each workspace lists every module's
alarms and farm alarms have no surface in tenants without the sensor module.

Package PKG-31, release R9, severity MEDIUM.

Where: console nav (`pages/sensor.ts`, `workspaces/shared.ts`), sensor-module `AlertsPage` and
`useAlerts.ts`, and `useConsoleDataAccess.ts`.

Root cause: alert-engine already stamps each alarm with its module (farm-service signals raise
FARM alarms, sensor readings raise SENSOR alarms), and `alertHistory` accepts a `module` filter.
The console, however, exposes one alarm list: a sensor-module page that every module workspace's
Overview shares. Its query sends no module, so Production lists sensor alarms and Control &
sensors lists farm alarms. The list and its counts are fetched only when the tenant holds sensor,
so a farm-only tenant's mortality, FCR and low-stock alarms have no surface at all.

Fix tier: 1. The alarm pages move to the dashboard remote as `alarms/{farm,sensor,hr}`, each
sending its module, and the old sensor routes redirect. The 1571-line EscalationPoliciesPage is
split during the move.

Pinned by: behaviour snapshots taken before the move, and page specs asserting that each route's
request carries its module. Acceptance: `/dashboard/alarms/farm` shows farm alarms only.

Rule broken. D4 (alert is module-scoped) and the plan section 2 model in which each workspace
shows only its own module's data.

Evidence:

```text
web/shell/src/console/nav/pages/sensor.ts:15-21 (the alarm list every workspace's Overview shares, path /sensor/alerts)
web/shell/src/console/nav/workspaces/shared.ts:20-37 (moduleOverviewArea puts that one page in every module workspace)
web/modules/sensor-module/src/hooks/useAlerts.ts:98-125 (alertHistory variables and query carry no module)
apps/alert-engine/src/alert/resolvers/alert.resolver.ts:103 (the module filter exists and the page does not use it)
apps/alert-engine/src/alert/entities/alert-module.enum.ts:12-17 (farm-service signals raise FARM alarms, sensor readings SENSOR)
web/shell/src/console/data/useConsoleDataAccess.ts:47-49 (alarms are fetched only when the tenant holds sensor)
```

## FE-MEDIUM-390

Defect. Console header annunciator sums every module's active alarms and renders on every
workspace, including Company, whenever any workspace lists the alarm page, so Company shows
module-private alarm counts.

Package PKG-31, release R9, severity MEDIUM.

Where: `web/shell/src/console/ConsoleShell.tsx` and `data/useAlarmSummary.ts`.

Root cause: the header annunciator is gated by `findNavPage(workspaces, 'alarms')`, which searches
every built workspace, not the active one. Its summary sums the active alarm counts of all
modules. The header renders on every workspace, so a viewer in Company sees P1/P2/P3 and
unacknowledged totals made of farm and sensor alarms, and clicking opens the sensor alarm list.
The per-module split already exists for the workspace menu (useWorkspaceAlarmCounts) from the same
request, but the annunciator does not use it.

Fix tier: 1. The annunciator reads only the active workspace's module counts and is not rendered
in Company.

Pinned by: ConsoleShell specs asserting that Company shows no annunciator and that each module
workspace shows only its own module's counts.

Rule broken. D2: a Company role never sees module-private data, and plan PKG-31 states that
Company shows no alarms.

Evidence:

```text
web/shell/src/console/ConsoleShell.tsx:134-141 (annunciator gate is findNavPage over all workspaces, not the active one)
web/shell/src/console/ConsoleShell.tsx:237-241 (annunciator rendered in the header regardless of the active workspace)
web/shell/src/console/data/useAlarmSummary.ts:10-12 (annunciator sums the alarms of all modules)
web/shell/src/console/nav/findNavPage.ts:10-21 (returns the first match in any workspace)
```

## HR-MEDIUM-072

Defect. Employee.farmId is a writable GraphQL field on create and update, validated only as a
UUID, never checked against the site registry and never approved by HR, and the EmployeeCreated
and EmployeeUpdated event contracts declare it although no producer ever fills it.

Package PKG-29, release R10, severity MEDIUM.

Where:

- create-employee.input.ts:225-228 accepts farmId with only @IsUUID, and UpdateEmployeeInput
  inherits it (update-employee.input.ts:9-11).
- create-employee.handler.ts:44-49 validates only the department, so any UUID ends up in
  Employee.farmId.
- Employee.farmId is also a GraphQL output field (employee.entity.ts:277-279), and the HR web
  fragment requests it (web/modules/hr-module/src/graphql/fragments.ts:91).
- The event contract declares farmId on EmployeeCreated and EmployeeUpdated (hr-events.ts:12-33),
  but the factories never set it (hr.events.ts:26-36), so consumers are promised a field that
  never arrives.

Root cause: farmId was the original farm placement and stayed in the public contract after
departments took over module placement. Any caller who can update an employee can attach them to
an arbitrary or deleted site, outside HR approval, and the site filters downstream (PKG-20) trust
it.

Fix (tier 1): with the duty-assignment UI in place, Employee.farmId leaves the entity mapping, the
inputs, GraphQL and the event interfaces (BREAKING footer). A site placement outside approved duty
can then no longer be expressed. The column is dropped in PKG-39 (C4).

Pinned by: the form, approvals and duties specs, plus codegen:check showing the field is gone from
the composed schema.

Rule broken. D5 says module duty is requested by managers and approved by HR, and ADR 052 makes
the farm-service registry the owner of sites, so a site link must not be a free, unvalidated
employee attribute.

Evidence:

```text
apps/hr-service/src/hr/dto/create-employee.input.ts:225-228 (farmId is writable with only @IsUUID)
apps/hr-service/src/hr/dto/update-employee.input.ts:9-11 (the update input inherits farmId from the create input)
apps/hr-service/src/hr/handlers/create-employee.handler.ts:44-49 (only the department is validated; farmId is stored unchecked)
apps/hr-service/src/hr/entities/employee.entity.ts:277-279 (Employee.farmId is a GraphQL output field and a column)
libs/event-contracts/src/hr-events.ts:12-33 (EmployeeCreated and EmployeeUpdated declare farmId)
apps/hr-service/src/hr/events/hr.events.ts:26-36 (the EmployeeCreated factory never sets farmId; 53-62 does the same for EmployeeUpdated)
```

## FE-MEDIUM-391

Defect. Company workspace offers the new AI chat entry and the shell header shows the AI assistant
trigger on every workspace, gated only by the AI capability, so the read-only Company layer offers
farm specialist personas.

Package PKG-32, release R10, severity MEDIUM.

Where: `workspaces/org.ts`, `pages/shell.ts` and `layouts/MainLayout.tsx`.

Root cause: the AI chat page is declared once and listed in every Overview, Company's included,
gated only by the AI surface capability. The shell header also renders the AI assistant trigger on
every workspace, gated on `ai_assistant:use` alone. The personas behind both include the farm
specialists (water health, production, operations), so the read-only Company layer offers a path
to module experts. D2 says a Company role never reaches module-private data, and an expert
answering from farm tools is module-private.

Fix tier: 1. Company lists no AI chat and the header trigger is not rendered there. Module
workspaces route to `/new-ai/{farm,sensor,hr}`.

Pinned by: a layout spec asserting that Company has no AI trigger, and a definitions spec
asserting that Company lists no AI page.

Rule broken. D2: Company never reaches module-private data, and an AI expert answering from a
module's tools is module-private.

Evidence:

```text
web/shell/src/console/nav/workspaces/org.ts:38 (Company overview lists SHELL_PAGES.newAiChat)
web/shell/src/console/nav/pages/shell.ts:40-48 (new AI chat gated only by the AI surface capability)
web/shell/src/layouts/MainLayout.tsx:40-42 (assistant drawer 'accessible from every module', gated by ai_assistant:use)
web/shell/src/layouts/MainLayout.tsx:53-64 (header trigger rendered in every workspace)
libs/shared-contracts/src/ai/persona-catalogue.ts:179-213 (farm-water-health, farm-production and farm-operations specialties)
```

## MSG-MEDIUM-088

Defect. messaging-service availableAiPersonas takes no module and filters the persona catalogue by
capability alone (tenant admins bypass), so every workspace's picker on web and mobile offers
every module's specialists regardless of the workspace it opens from.

Package PKG-32, release R10, severity MEDIUM.

Where: messaging-service `ai/resolvers/ai.resolver.ts` and `ai-personas-registry.service.ts`, plus
the web and mobile picker documents.

Root cause: the picker query filters `AI_PERSONA_CATALOGUE` only by the caller's capabilities
(tier plus specialty module), tenant admins bypass the filter, and the query takes no module
argument. The catalogue already knows each specialty's `requiresModule`, but the workspace the
picker opens from never reaches the resolver. Control & sensors therefore offers the farm
water-health experts, and a tenant admin sees every specialist everywhere.

Fix tier: 1, with C2 compatibility. `availableAiPersonas(module)` becomes an optional narrowing
argument on a scope the server derives. A request for a wider scope is FORBIDDEN, and old clients
keep working.

Pinned by: resolver specs (the module narrows and never widens; the general persona belongs to no
module), web layout specs, and the regenerated aquamobil document.

Rule broken. D4: messaging and ai are module-scoped, so the persona offer must be narrowed to the
module of the workspace that asks.

Evidence:

```text
apps/messaging-service/src/ai/resolvers/ai.resolver.ts:151-164 (no module argument; filtered by roles and resource permissions only)
apps/messaging-service/src/ai/services/ai-personas-registry.service.ts:11-13 (filter is tier and specialty capability, admins bypass)
apps/messaging-service/src/ai/services/ai-personas-registry.service.ts:78-83 (catalogue filtered by required capabilities only)
web/modules/messaging-module/src/graphql/messaging-operations.ts:102-113 (web picker query sends no module)
web/apps/aquamobil/src/graphql/messaging-operations.ts:299-310 (mobile picker query sends no module)
```

## RBAC-MEDIUM-040

Defect. Company layer has no read model: the auth tenant identity and module list are tenant-admin
only, and Company workforce and registry views reuse module pages over module-private types
(Employee contact PII, farm Site), so a Company viewer without module grants cannot be served
without module-private fields.

Package PKG-33, release R10, severity MEDIUM.

Where: auth `tenant.resolver.ts`, hr `employee.entity.ts` and `hr.resolver.ts`, and the Company nav.

Root cause: Company was assembled from module pages rather than from a read model of its own.

- The Company identity (`myTenant`) and the module list (`myTenantModules`) are tenant-admin only.
- The workforce view is the HR employees page over the full `Employee` type (email, contactInfo,
  address), unmasked for any global TENANT_ADMIN or MODULE_MANAGER.
- Sites and suppliers come from the farm registry types, which carry farm-only attributes.

There is no purpose-built field set and no Company decision. The D2 Company viewer (role B)
therefore either sees nothing, or must be given module grants and then sees module-private fields.

Fix tier: 1. Dedicated projections (`companyRegistryLayer`, `companyFinanceTotals`,
`companyWorkforceLayer`, `companyModules`, `companyIdentity`) with nullable roots, gated by
`company:view`.

Pinned by: `tests/invariants/company-layer-projection.spec.ts` (no Company DTO field is
module-private), plus resolver specs in which role A gets FORBIDDEN and role B is allowed.

Rule broken. D1 and D2: Company is a read-only umbrella over common kinds, and a Company role
never sees module-private data.

Evidence:

```text
apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts:158-161 (myTenant, the company identity, is TenantAdminOrHigher only)
apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts:227-230 (myTenantModules is TenantAdminOrHigher only)
web/shell/src/console/nav/workspaces/org.ts:58-61 (the Company workforce view is the HR module pages themselves)
apps/hr-service/src/hr/entities/employee.entity.ts:190-200 (Employee type exposes email, contactInfo and address)
apps/hr-service/src/hr/hr.resolver.ts:83-93 (full contact PII is returned to any global TENANT_ADMIN or MODULE_MANAGER)
```

## FE-MEDIUM-392

Defect. Console nav page visibility is a hand-written mirror of route guards keyed on the global
role and the tenant's module list, with no access layer on a page, so the rail can offer pages the
API refuses and listing a module-private page in Company type-checks.

Package PKG-34, release R10, severity MEDIUM.

Where: `web/shell/src/console/nav/pageAccess.ts` and `types.ts`.

Root cause: `canSeePage` mirrors the route guards by hand. A module mount needs the tenant to hold
the module, `requiredRoles` lists global roles, and `requiredPermission` names a capability.
Nothing ties a page to the GraphQL operations it calls, and no page declares its access layer
(module, scoped, company, self or account). As a result, a global MODULE_MANAGER sees farm finance
in every workspace, and Company can list a module-private page without any check failing. Once the
services decide by module grant (PKG-07..12), the nav would keep deciding by global role, and the
UI would offer what the API refuses.

Fix tier: 1+2. Every page carries a required `layer`, and `canSeePage` calls the shared
`decideAccess`. A codegen-built operation access manifest replaces the hand-kept mirror.

Pinned by: a viewer property spec (no section 2 viewer sees a page that `decideAccess` denies) and
the `operation-access-manifest-fresh` invariant. Listing a module-private page in Company becomes
a type error.

Rule broken. Plan PKG-02/PKG-34: one pure decideAccess decides every access, including the nav, so
the UI cannot offer what the API refuses.

Evidence:

```text
web/shell/src/console/nav/pageAccess.ts:1-15 (documented as the nav's hand-kept mirror of the route guards)
web/shell/src/console/nav/pageAccess.ts:26-39 (decides by tenant module list, global requiredRoles and a capability)
web/shell/src/console/nav/types.ts:107-118 (page gates are global ConsoleRole lists and flags; no layer)
web/shell/src/console/nav/types.ts:137-146 (WorkspaceDef carries an optional module; Company has none, and nothing types a page's layer)
web/shell/src/console/nav/pages/finance.ts:14 (FINANCE_ROLES lets any global MODULE_MANAGER see finance in every workspace)
```

## FE-MEDIUM-393

Defect. Web action gates (permission-matrix, sensor-permission-matrix, useCanMutate) are
hand-picked mirrors of backend @Roles decided on users.role and cover a handful of mutations, so
every unlisted UI action is offered whether or not the API accepts it.

Package PKG-34, release R10, severity MEDIUM.

Where: `web/shared-ui/src/authz/`.

Root cause: buttons are gated by `useCanMutate`, a role-list lookup over two hand-maintained
mirrors: a subset of the farm-service permission matrix, and two sensor mutations copied from
resolver decorators. The file header limits the mirror to the handful of mutations the UI
surfaces, and the parity specs check only the listed names. Every other mutation button therefore
renders for everyone, and a 403 is the only feedback. The decision is membership of `users.role`,
which cannot express module grants or site scope.

Fix tier: 1+2. The mirrors and `useCanMutate` are deleted. A generated operation access manifest
plus `useCanPerform` derives every action gate from the same `decideAccess` that the services run.

Pinned by: the manifest freshness invariant and the `useCanPerform` specs.

Rule broken. Plan PKG-34 goal (the UI cannot offer what the API refuses) and the repo rule against
hand-maintained copies of a single source of truth.

Evidence:

```text
web/shared-ui/src/authz/permission-matrix.ts:1-6 (mirror of the farm-service permission matrix, a subset)
web/shared-ui/src/authz/permission-matrix.ts:26-33 (scope rule: only the handful of mutations the UI surfaces are mirrored)
web/shared-ui/src/authz/sensor-permission-matrix.ts:1-22 (two sensor mutations copied from resolver @Roles)
web/shared-ui/src/authz/useCanMutate.ts:30-53 (gate is membership of user.role in the mirrored list)
```

## FE-MEDIUM-394

Defect. Company workspace and its /tenant landing have no gate: the workspace appears for anyone
with an entry, the company dashboard admits every authenticated member, and module-less members
land there, so a production manager cannot be denied Company.

Package PKG-35, release R11, severity MEDIUM.

Where: `workspaces/org.ts`, `pages/tenant.ts`, `rootLanding.ts` and tenant-admin `Module.tsx`.

Root cause: Company was designed as the workspace with no module, and it appears for anyone who
has an entry to show. Its home, the company dashboard, is wrapped in `RequireTenantMember`, which
admits any authenticated user, and members without a module workspace land there. No capability
means 'may see Company', so the owner's requirement that a production manager can be denied
Company entirely (D2) has no mechanism. Role A always has a Company workspace.

Fix tier: 1. A `company:view` gate on the workspace, the landing and the route. Role A lands on
Production, and the read-only tree page replaces the module pages.

Pinned by: nav and landing specs in which role A has no Company workspace and is refused
`/tenant`, while role B sees the tree. Staging screenshots of both roles are attached to the PR.

Rule broken. D2: a production manager can be denied Company entirely.

Evidence:

```text
web/shell/src/console/nav/workspaces/org.ts:1-4 (no module gates the workspace; it appears for anyone with an entry)
web/shell/src/console/nav/types.ts:143-144 (Company has no module requirement)
web/shell/src/console/nav/pages/tenant.ts:15-22 (the company dashboard opens for every tenant user)
web/modules/tenant-admin/src/Module.tsx:78 (index route wrapped in RequireTenantMember)
web/modules/tenant-admin/src/components/common/RequireTenantAdmin.tsx:37-49 (RequireTenantMember admits any authenticated user)
web/shell/src/console/nav/rootLanding.ts:28-35 (tenant admins and module-less members land on /tenant)
```

## FE-MEDIUM-395

Defect. Console pages are listed in several workspaces at once (alarms, tasks, maintenance,
storage, finance, team pages, roles, AI chat, equipment) and the definitions spec requires it, so
a URL's workspace and its HR module scope depend on navigation history instead of the URL.

Package PKG-36, release R11, severity MEDIUM.

Where: the console workspace definitions and `workspaceForPath.ts`.

Root cause: the console shares pages between workspaces by design:

- every module Overview carries the analytics, alarm, messaging and AI pages;
- every module workspace carries the HR team area;
- Control & sensors and Greenhouse list farm-module pages (tasks, maintenance, storage, equipment,
  farm finance);
- Company carries the personal profile page.

`definitions.spec.ts` even asserts that this set stays shared. When a URL belongs to several
workspaces, the rail keeps the current one, and the shell scopes HR pages to the module of the
followed workspace. The same `/hr/employees` URL therefore lists different people depending on
where the user came from.

Fix tier: 3 plus 1. The definitions spec is inverted to require exactly one workspace per URL,
with messaging the only exception. Pages move to their owner workspace, and personal pages move to
a new personal workspace.

Pinned by: `definitions.spec.ts`, red on today's definitions and green after.

Rule broken. Plan PKG-36: every URL maps to exactly one workspace, and messaging is the only
shared page.

Evidence:

```text
web/shell/src/console/nav/__tests__/definitions.spec.ts:49-65 (asserts that the shared set stays in more than one workspace)
web/shell/src/console/nav/workspaces/shared.ts:20-65 (overview and team areas are carried by every module workspace)
web/shell/src/console/nav/workspaces/ctl.ts:73-87 (Control & sensors lists farm-module pages: maintenance, equipment, tasks, storage, farm finance)
web/shell/src/console/nav/workspaces/gh.ts:27-40 (Greenhouse lists farm site work and farm finance)
web/shell/src/console/nav/workspaceForPath.ts:58-63 (a URL claimed by several workspaces keeps the current one)
web/shell/src/console/ConsoleShell.tsx:125-129 (HR pages are scoped to the followed workspace's module)
```

## PROC-MEDIUM-065

Defect. End-to-end suites hold no proof of module boundaries: generated tokens default to every
module, the only module-assignment workflow assigns the tenant admin and asserts only an array
shape, and the fixture cannot build role A or role B, so D2, D5 and D6 can regress silently.

Package PKG-41, release R11, severity MEDIUM.

Where: `e2e/`.

Root cause: the end-to-end suites were written for tenant isolation and account-level escalation,
never for module boundaries.

- The JWT helper defaults every token to all modules, so a module-scoped denial cannot fail a test.
- The only module-assignment workflow assigns the tenant admin itself and returns early when the
  tenant has no module. It verifies 'access' by asserting that `myModules` is an array.
- The security suites test account mutations by global role, and header spoofing of roles and user
  id, with no forged module claim.
- The tenant fixture can only create users with a tenant role, so neither role A (farm manager
  without Company) nor role B (Company Viewer without grants) can be built.

D2, D5 and D6 therefore have no proof on any surface and can regress silently.

Fix tier: 3. A matrix generated from the operation access manifest and the section 2 viewers, with
an invariant requiring a cell for every classified operation and viewer, across GraphQL, REST
upload, NATS AI, sockets, notifications and messaging.

Pinned by: `e2e/tests/{integration,security}/module-access-layers.spec.ts`. Every cell green is
the merge gate for PKG-36 and R13.

Rule broken. Plan section 7 mandatory cells (D2, D5, D6, revocation timing, header spoofing) and
the repo hierarchy: a boundary that is not proven is not detectable.

Evidence:

```text
e2e/helpers/jwt.helper.ts:109-118 (generated tokens default modules to ALL_MODULES and carry no per-module role)
e2e/tests/workflow/module-assignment.spec.ts:54-65 (returns early when the tenant has no module; assigns the tenant admin itself)
e2e/tests/workflow/module-assignment.spec.ts:112-114 ('verify access' asserts only that myModules is an array)
e2e/tests/security/rbac-escalation.spec.ts:77-187 (only account-level mutations by global role)
e2e/helpers/tenant.fixture.ts:160-167 (CreateTenantUserInput carries a tenant roleId only; no module grant)
```

## FARM-HIGH-475

Defect. Farm-service keeps a second personnel roster: farm_workers stores names, e-mail and phone
outside HR, numbers people in the same EMP-year format as HR employees, fabricates department and
hire date, and lets any MODULE_MANAGER add staff without HR.

Package PKG-37, release R12, severity HIGH.

Where:

- worker.entity.ts:1-9 declares farm_workers a roster separate from hr employees, with encrypted
  first name, last name, e-mail and contact info (67-92).
- worker.resolver.ts:48-50 lets TENANT_ADMIN and MODULE_MANAGER create workers.
- create-worker.handler.ts:44-61 numbers them EMP-&lt;year&gt;-NNNNN from farm_workers, the same
  format hr-service generates from employees (create-employee.handler.ts:138-140).
- create-worker.handler.ts:77-84 writes a fabricated department 'operations', a hire date of now
  and an empty phone.
- The roster is managed from the farm Setup Workers tab (SetupPage.tsx:246).

Root cause: the roster predates HR and was trimmed, not retired (worker.entity.ts:5-9). As a result:

- personal data lives in two services;
- one person can carry two records, and the same employee number can denote two different people;
- HR never sees farm staff, so D5 approval is bypassed.

Fix (tier 1+3):

- W0: an operator-approved count-only report.
- W1: an HR import queue creates or links an employee, with an APPROVED farm assignment and a
  veterinary certification.
- W2: farm stamps resolvedAt and remaps the references.
- W3 (BREAKING): the UI, API and WorkerModule are removed, so a farm roster can no longer be
  written (tier 1).

Pinned by: a report-contains-no-PII spec, an atomic import spec, an idempotent remap spec and
tests/invariants/farm-no-worker-roster.spec.ts (tier 3).

Rule broken. D8 removes Farm Workers (the farm workforce is an HR employee plus a farm
assignment), and D5 says HR adds employees.

Evidence:

```text
apps/farm-service/src/worker/entities/worker.entity.ts:1-9 (farm_workers is a roster separate from the hr employees table)
apps/farm-service/src/worker/entities/worker.entity.ts:67-92 (first name, last name, e-mail and contact info are stored in farm-service)
apps/farm-service/src/worker/worker.resolver.ts:48-50 (createWorker is open to TENANT_ADMIN and MODULE_MANAGER, with no HR step)
apps/farm-service/src/worker/handlers/create-worker.handler.ts:44-61 (assigns EMP-<year>-NNNNN from farm_workers, the same format hr-service generates at apps/hr-service/src/hr/handlers/create-employee.handler.ts:138-140)
apps/farm-service/src/worker/handlers/create-worker.handler.ts:77-84 (placeholder data: an empty phone, department 'operations' and hireDate set to now)
web/modules/farm-module/src/pages/setup/SetupPage.tsx:246 (the roster is managed from the farm Setup Workers tab)
```

## FARM-MEDIUM-476

Defect. Farm person references point into two unrelated id spaces: treatment veterinarian
attribution stores an unchecked farm_workers id, and the task assignee picker writes either
farm_workers ids or auth user ids into assignedTo, so a task given to a farm worker appears in
nobody's task list.

Package PKG-37, release R12, severity MEDIUM.

Where:

- treatment-application.entity.ts:134-137 stores veterinarianWorkerId as a plain uuid with no
  relation. treatment-application.service.ts:66 saves it after only @IsUUID validation. Nothing
  checks that the worker exists or is a veterinarian.
- useTenantUsers.ts:76-90 merges farm_workers rows into the tenant-user list; its comment wrongly
  calls them employees.
- TaskFormModal.tsx:62-66 writes the chosen id into task.assignedTo (task.entity.ts:213-215),
  which carries no marker of its id space.
- Server code reads assignedTo as an auth user id: list-my-tasks.handler.ts:28 matches it against
  the caller.

Root cause: the private roster leaked into shared reference columns without a type. As a result:

- a task assigned to a farm worker id appears in nobody's My Tasks list;
- removing the roster would orphan the veterinarian attribution.

Fix (tier 1+3):

- W2 remaps tasks, templates and treatments idempotently away from farm_workers ids.
- Treatments gain veterinarianEmployeeId, backed by the HR veterinary certification.
- veterinarianWorkerId is unmapped in W3 and dropped in PKG-38, so a farm-worker id can no longer
  be stored (tier 1).

Pinned by: the idempotent remap spec and tests/invariants/farm-no-worker-roster.spec.ts (tier 3).

Rule broken. D8 makes the farm workforce an HR employee plus a farm assignment, and the repo
single-source-of-truth rule requires a person reference to name one identity space.

Evidence:

```text
apps/farm-service/src/fish-health/entities/treatment-application.entity.ts:134-137 (veterinarianWorkerId is a plain uuid into farm_workers with no relation)
apps/farm-service/src/fish-health/services/treatment-application.service.ts:66 (stored as given; the input checks only @IsUUID at dto/field-capture.inputs.ts:178-181)
web/modules/farm-module/src/hooks/useTenantUsers.ts:76-90 (the assignee list merges farm_workers ids into the auth tenant users)
web/modules/farm-module/src/pages/tasks/components/TaskFormModal.tsx:62-66 (the selected id is written to assignedTo)
apps/farm-service/src/task/entities/task.entity.ts:213-215 (assignedTo is a uuid with no marker of which id space it belongs to)
apps/farm-service/src/task/handlers/list-my-tasks.handler.ts:28 (My Tasks matches assignedTo against the caller's auth user id)
```

## FARM-MEDIUM-477

Defect. farm finance_expense_entries.siteId is a bare uuid with no foreign key to sites and its
integrity is held only by a handler check, so the database accepts a site id that names no site
and the site-scoped ledger filters on it.

Package PKG-38, release R13, severity MEDIUM.

Where: farm-service `finance_expense_entries`.

Root cause: `CreateFinanceTables` gave `categoryId` a foreign key but left `siteId` as a bare
uuid. The entity maps `siteId` as a plain column with no relation, and site integrity lives only
in `validateEntryDimensions`. That handler's own header states that without it, a typo'd or
foreign id books a phantom per-site cost line. A handler check is tier 3 at best: the database
still accepts a site id that names no site, and the site-scoped ledger filters on the column as if
it were trustworthy. Whether orphan values exist in production is UNVERIFIED; it is an operator
count in plan section 3.

Fix tier: 1. A foreign key is added NOT VALID, then validated in its own migration once the
operator count of orphan site ids is zero (C7).

Pinned by: a migration-harness spec on real Postgres, in which an orphan insert is rejected after
validation and the validating migration refuses to run on a non-zero count, plus the DESTRUCTIVE
and count-refusal markers.

Rule broken. Repo hierarchy impossible &gt; automatic &gt; detectable: referential integrity that
the database can enforce is left to a handler check.

Evidence:

```text
apps/farm-service/src/database/migrations/1804600000000-CreateFinanceTables.ts:122-129 (categoryId gets REFERENCES; siteId is UUID NULL with none)
apps/farm-service/src/finance/entities/finance-expense-entry.entity.ts:110-112 (siteId mapped as a plain uuid column with no relation)
apps/farm-service/src/finance/handlers/validate-entry-dimensions.ts:5-8 (states that without the check a typo'd or foreign id books a phantom per-site cost)
apps/farm-service/src/finance/handlers/validate-entry-dimensions.ts:33-41 (the only site existence check is application code)
apps/farm-service/src/finance/services/finance-ledger-query.service.ts:593 (site-scoped ledger filters on the unreferenced column)
```

## FARM-MEDIUM-478

Defect. farm departments.siteId is nullable and its foreign key was changed to ON DELETE SET NULL
while CreateDepartmentInput requires a site, so removing a site silently orphans its departments
and every reader must handle a site department with no site.

Package PKG-38, release R13, severity MEDIUM.

Where: farm-service `departments`.

Root cause: the baseline created `departments.siteId` as nullable, and `AddSiteContractFields`
replaced its RESTRICT foreign key with ON DELETE SET NULL. The entity states the intent:
departments are orphaned when their site is deleted. Yet `CreateDepartmentInput` requires a site,
so the write contract and the schema disagree. Sites are normally soft-deleted, but any hard
removal of a site silently detaches its departments, and every reader of the D1 tree (Company &gt;
module &gt; site &gt; department) must handle a site department with no site. The number of NULL
rows today is UNVERIFIED.

Fix tier: 1. Once the operator count of NULL `siteId` values is zero, a dedicated migration sets
NOT NULL. With NOT NULL in place, the SET NULL action can no longer orphan a department: removing
a site that still has departments fails.

Pinned by: a count-refusal spec (the migration aborts on non-zero NULLs), a harness spec showing
that deleting a site with departments fails, and the entity typed non-null in the same release.

Rule broken. D1 (the tree is Company &gt; module &gt; site &gt; department) and plan rule C3: the
column must match the write contract.

Evidence:

```text
apps/farm-service/src/database/migrations/1800000000000-Baseline.ts:45 (departments created with a nullable siteId)
apps/farm-service/src/database/migrations/1801400000000-AddSiteContractFields.ts:60-63 (FK replaced with ON DELETE SET NULL)
apps/farm-service/src/department/entities/department.entity.ts:94-104 (nullable siteId; comment: orphaned departments when site is deleted)
apps/farm-service/src/department/dto/create-department.input.ts:58-61 (the create contract requires siteId)
```

## HR-MEDIUM-073

Defect. hr departments_hr.siteId and parentDepartmentId are untyped varchar columns with no
foreign key, the update handler rejects only a direct self-parent and soft-deleting a unit ignores
its child units, so the organisation-unit tree can hold cycles, dangling parents and non-uuid
references.

Package PKG-39, release R13, severity MEDIUM.

Where: hr-service `departments_hr`.

Root cause: the baseline created `siteId` and `parentDepartmentId` as `character varying` with no
foreign key, and the entity maps them as untyped strings. Integrity is attempted only in handlers.
Create and update validate the uuid format and look up the parent, but update rejects only a unit
that names itself as parent, so a cycle such as A&gt;B&gt;A passes. Soft-deleting a unit counts
its employees but not its child units, so children keep pointing at a deleted parent. Migrations
already need `id::text` casts to join the tree. The D7 organisation units that Company and HR
render are therefore not guaranteed to form a tree.

Fix tier: 1. Once the count of non-uuid values is zero, `siteId` and `parentDepartmentId` are cast
to uuid in their own migration (C7). The parent self-FK lands together with the erasure fix for
self-references (the companion finding).

Pinned by: a harness spec on real Postgres (the cast refuses non-uuid rows; a dangling parent is
rejected) and a real-Postgres tenant-erasure spec over the hr schema.

Rule broken. D7 (organisation units are the hr-owned structure that Company renders) and the repo
hierarchy: integrity is enforceable in the database but is left to partial handler checks.

Evidence:

```text
apps/hr-service/src/database/migrations/1800000000000-Baseline.ts:23 (siteId and parentDepartmentId created as character varying with no FK)
apps/hr-service/src/hr/entities/department.entity.ts:29-40 (both mapped as untyped strings)
apps/hr-service/src/hr/handlers/update-department.handler.ts:46-55 (only parent == self is rejected; A->B->A passes)
apps/hr-service/src/hr/handlers/update-department.handler.ts:57-70 (soft delete counts employees only; child units keep a deleted parent)
apps/hr-service/src/database/migrations/1802500000000-RetireEmployeeLegacyDepartment.ts:364 (joining the tree needs an id::text cast)
```

## SEC-MEDIUM-211

Defect. Tenant erasure FK sort counts a self-referencing foreign key as a cycle and aborts, so no
erased schema can carry a self-FK and the hr organisation-unit parent cannot be made referentially
safe; hr goals already declares such a self-FK.

Package PKG-39, release R13, severity MEDIUM.

Where: `libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-executor.ts`, in
`sortedTablesForDelete`.

Root cause: the delete order comes from a Kahn topological sort over the foreign-key edges read
from `information_schema`. A self-referencing foreign key produces an edge from a table to itself.
The table's indegree becomes 1 and only its own processing could release it, so it never enters
the queue and the method throws 'cannot derive FK-safe delete order'. Self-references are a normal
tree shape: hr `goals.parentGoalId` already references `goals`, and `goals` is among the hr tables
the executor erases. Whether tenant hr schemas carry that constraint, and so whether hr tenant
erasure already aborts, is UNVERIFIED. Either way, adding the `departments_hr` parent FK would
make erasure of the hr module fail.

Fix tier: 1. Self edges are excluded from the table ordering. A whole-table DELETE removes parent
and child rows in one statement, which a NO ACTION self-reference permits.

Pinned by: a sort unit spec with a self edge, and a real-Postgres tenant-erasure spec over an hr
schema that contains self-referencing tables.

Rule broken. Repo rule of root-cause fixes: the erasure guarantee must hold for every valid schema
shape, and a tree-shaped self-reference is a valid shape.

Evidence:

```text
libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-executor.ts:554-561 (a self edge adds the table to its own parents and raises its indegree)
libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-executor.ts:582-586 (an unsorted table throws 'cannot derive FK-safe delete order')
apps/hr-service/src/database/migrations/1800000000000-Baseline.ts:226 (goals.parentGoalId REFERENCES goals)
libs/backend-common/src/database/schema-manager.service.ts:679 (goals is among the hr module tables the executor erases)
libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-registry.ts:210-217 (hr erasure runs in tenant-schema-module mode)
```

## RBAC-LOW-042

Defect. auth user_module_assignments.permissions is a jsonb column with no writer and no reader
beyond an uncalled hasPermission method, exposed in GraphQL as a String over a JSON object, so it
reads as fine-grained module access that nothing enforces.

Package PKG-40, release R13, severity LOW.

Where: auth-service `user-module-assignment.entity.ts`.

Root cause: the assignment row carries a `permissions` jsonb column (described as custom,
fine-grained access control within the module) and a `hasPermission` helper. Nothing writes the
column, since the assignment create and reactivate paths set only role and activity. Nothing calls
the helper, and no guard reads the column. The GraphQL field is declared `String` over a
`Record<string, boolean>`, so a non-null value would fail serialization. The column looks like a
fine-grained module access store that is enforced nowhere, which invites a future writer to rely
on it.

Fix tier: 1. PKG-06 removes it from the entity and GraphQL, leaving an orphan (class E). This
package drops it in the following release.

Pinned by: `tests/invariants/contract-drop-orphan-first.spec.ts` and the migration gate.

Rule broken. Repo rule against dead authority surfaces: a permission store that no decision reads
must not exist beside the real one.

Evidence:

```text
apps/auth-service/src/modules/authentication/entities/user-module-assignment.entity.ts:77-83 (jsonb permissions described as fine-grained access control, typed @Field String)
apps/auth-service/src/modules/authentication/entities/user-module-assignment.entity.ts:145-151 (hasPermission helper with no caller)
apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:360-366 (assignment create sets role and activity only, never permissions)
apps/auth-service/src/migrations/1800000000000-Baseline.ts:52 (column created in auth.user_module_assignments)
```

## RBAC-MEDIUM-041

Defect. auth keeps two disjoint records of who manages a module, tenant_modules.managerId (written
only by Assign/Remove Manager) and user_module_assignments.isPrimaryManager (written only by the
member assignment flow), and no access decision reads managerId, so the admin UI shows a manager
that grants nothing.

Package PKG-40, release R13, severity MEDIUM.

Where: auth-service `tenant_modules` and `user_module_assignments`.

Root cause: two features each invented a 'manager of module m' record. Assign Manager writes
`tenant_modules.managerId` and promotes `users.role`, and Remove Manager clears it. The member
assignment flow writes `user_module_assignments.isPrimaryManager` instead. Neither path updates
the other, and no access decision in any service reads `managerId`. The tenant-admin module page
shows it as the module's manager, while authority actually comes from the global role. The two
records can name different people, and clearing `managerId` revokes nothing.

Fix tier: 1. The PKG-04 backfill folds every non-null `managerId` into a MODULE_MANAGER grant, and
PKG-06 removes the mutations and the field. This package then drops the column, after a count
proves that every non-null value was converted.

Pinned by: a count-refusal spec on the drop migration and the `contract-drop-orphan-first`
invariant (the column is absent from the entities on the merge base).

Rule broken. Repo single-source-of-truth rule and plan section 2: module authority is one
per-module grant carried in moduleAccess.

Evidence:

```text
apps/auth-service/src/modules/tenant/entities/tenant-module.entity.ts:102-108 (managerId: the user responsible for managing this module)
apps/auth-service/src/modules/authentication/entities/user-module-assignment.entity.ts:62-68 (isPrimaryManager: the primary manager for this module)
apps/auth-service/src/modules/tenant/services/tenant.service.ts:578-586 (Assign Manager writes managerId and promotes users.role, never isPrimaryManager)
apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:337-366 (member assignment writes isPrimaryManager, never managerId)
apps/auth-service/src/modules/tenant/services/tenant.service.ts:609 (Remove Manager clears managerId only; the role and isPrimaryManager stay)
web/modules/tenant-admin/src/graphql/module-queries.ts:44 (admin UI reads managerId as the module manager)
```

## FARM-HIGH-483

Defect. Fourteen farm-private events the /farms socket pushes carry no siteId on the wire
(BatchCreated, FeedingRecorded, MealFed, MealSkipped, TankCreated, TankUpdated,
TankStatusChanged, TankDeleted, SubEquipmentCreated, SubEquipmentUpdated, SubEquipmentDeleted,
FeederCalibrationsSaved, TankCleared, BatchProductionCompleted), so a site-bound farm operator
receives none of them live once /farms rooms are scoped by site, although it may read every one
of them for its own site.

Raised in the PKG-10 review, release R4, severity HIGH.

Where. `FARM_WS_EVENT_ACCESS` (apps/gateway-api/src/websocket/farm-ws-event-access.ts) maps an
event to the farm site room only when its wire schema declares `siteId`. The fourteen schemas
above declare none, and every schema carries `additionalProperties: false`, so a producer that
added the field today would have its events dropped by the bridge. These events therefore reach
the farm module room only: members tenant-wide in farm receive them, and the operator on S1 does
not. AquaMobil invalidates its tank, feeding-plan and daily-count queries on all fourteen; before
PKG-10 the operator received them through `tenant:{id}`.

Root cause. The farm events were designed for one tenant-wide room, so their producers never
named the site of the tank, batch, meal or feeder they describe. LowStockDetected also carries no
site, but that is FARM-HIGH-336 (minStock is catalog-level), not this finding.

Fix tier 1 (impossible), sequenced under C5, consumer first:

- PR1, one release before R4 enforcement: an optional `siteId` on the fourteen wire interfaces
  (libs/event-contracts/src/farm-events.ts) and JSON schemas (schemas/farm-events.schema.ts), so
  every consumer accepts it.
- PR2, by R4: the farm-service producers stamp the site of the row they describe, and the fourteen
  `FARM_WS_EVENT_ACCESS` entries become `ON_SITE`.

The alternative is an owner decision, recorded in ADR-051 §4, that site-bound operators see these
rows only on refetch.

Pinned by `farm-ws-event-access.spec.ts`: once a schema declares `siteId`, the spec requires its
entry to route by site. `farm.gateway.rooms.spec.ts` pins that the S1 operator does not receive
MealFed today; PR2 turns that case around.

Rule broken. ADR-051 §4: the farm operator on S1 reads the batches, tanks, feeding and meals of
its own site, so the realtime pushes of those rows must reach it for its site. A site assignment
restricts what an operator sees; it must not blind it.

Evidence:

```text
apps/gateway-api/src/websocket/farm-ws-event-access.ts:71-110 (the fourteen events are NO_SITE: farm module room only)
libs/event-contracts/src/schemas/farm-events.schema.ts:749-760 (BatchCreated declares no siteId; additionalProperties false through EVENT_OBJECT_OPTS)
libs/event-contracts/src/schemas/farm-events.schema.ts:1152-1200 (MealFed and MealSkipped declare no siteId)
web/apps/aquamobil/src/utils/farm-realtime-invalidation.ts:64-91 (AquaMobil invalidates its queries on these events)
apps/gateway-api/src/websocket/__tests__/farm.gateway.rooms.spec.ts:122 (the S1 operator does not receive MealFed)
```

## SENSOR-MEDIUM-204

Defect. sensor-service answers `st.language.*` requests for the whole tenant: tag completions,
FB definitions and the variables of any programId the request names. The requests carry no
member caller and no site scope, so the /st-language socket cannot admit a site-bound sensor
operator.

Package PKG-11, release R5, severity MEDIUM. Raised in the PKG-10 review.

Where. The gateway's ST bridge sends each `st:request` to `st.language.{type}` with only the
`x-tenant-id` header. sensor-service's handler reads the tenant from that header and calls
`STLanguageService`. The service resolves `getTagCompletions(tenantId)`,
`getFBDefinitions(tenantId)` and `getProgramVariables(programId, tenantId)`; the last one finds
variables by `programId` alone. A program belongs to an edge device (`AutomationProgram.deviceId`),
and the device carries the site.

Root cause. The ST language service was built for tenant isolation only, and the gateway decided
nothing beyond the tenant. PKG-10 now admits to /st-language only members who are tenant-wide in
sensor (a sensor MODULE_MANAGER, TENANT_ADMIN), and refuses a site-bound sensor MODULE_USER: the
gateway cannot scope a request by the site of the program it names. That restriction can be lifted
only once sensor-service decides each request itself.

Fix tier 1 (impossible). PKG-11 takes the st.language responder (`st-language.handler.ts`,
`st-language.service.ts`, `st-intellisense.service.ts`) and the gateway ST bridge
(`st-language-bridge.service.ts`) into its scope:

- the request carries the member caller;
- sensor-service decides `module('sensor')` with the site of the named program (device, then
  site);
- tag and FB completions are filtered to the caller's sites;
- the /st-language handshake then admits site-bound operators to their site rooms.

Pinned by `st-language.gateway.rooms.spec.ts`, which refuses the S9 sensor operator today; PKG-11
turns that case into an admission together with responder specs for an S9 operator naming a
program on another site.

Rule broken. ADR-051 §1: a site assignment restricts every module where the user is MODULE_USER.
ADR-051 §3: a path without a GraphQL guard decides at one chokepoint with the member's scope.

Evidence:

```text
apps/sensor-service/src/automation/compiler/services/st-language.service.ts:81-91 (completions resolve tags, FB definitions and program variables by tenant and programId only)
apps/sensor-service/src/automation/compiler/services/st-intellisense.service.ts:95-108 (program variables are found by programId alone, no site)
apps/sensor-service/src/automation/compiler/nats-handlers/st-language.handler.ts:125-131 (the tenant comes from the x-tenant-id header; no member caller)
apps/gateway-api/src/websocket/st-language-bridge.service.ts:147-164 (the gateway sends only the tenant header)
apps/sensor-service/src/automation/entities/automation-program.entity.ts:146 (a program names its device, which carries the site)
```
