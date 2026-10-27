# ADR-051 — Module access layers

Per-module grants, one decision function, read-only Company.

- **Status:** Proposed; approved by the architectural-arbiter on 2026-10-26 (five minor points are
  carried to implementation, see the last section). No package below merges code before the owner
  marks this record Accepted (PKG-00 gate). Accepting it answers plan §9 OQ1 with its default.
- **Date:** 2026-10-26
- **Owner:** platform owner (Okan) + architectural-arbiter
- **Tracking:** anchors allocated by PKG-00 with `npm run findings:add -- RBAC …` (never by hand);
  narrative in `docs/reviews/claude/2026-10-26-module-boundaries.md`. Links the open
  `HR-HIGH-056` (hr operations gated by nothing beyond authentication).
- **Relates to:** ADR-008 (guard defense in depth), ADR-011 (schema ownership), ADR-015 (NATS
  identity is the certificate CN), ADR-0016 (projected claim with durable invalidation, the
  precedent for `moduleAccess`:
  `docs/recommendations/architectural-arbiter/2026-09-05-adr-0016-platform-capabilities-projected-claim.md:24-31,63-69`),
  ADR-052 (module-keyed registry) and ADR-053 (catalog-only `ADD COLUMN`), both planned in PKG-00;
  the module boundaries plan of 2026-10-26, §2, §4, §7, §9. Code paths are relative to the deploy
  checkout at `33de2433b`, where every cited line was re-read; `node_modules` paths are
  `@nestjs/graphql` 13.4.2, `@nestjs/core` 11.1.27 and `@nestjs/apollo` 13.4.2 as installed there.

## Context

Module boundaries exist only in the console nav. No backend enforces them.

| Gap today                                                                                                                                                                                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The token carries `role`/`roles` from `users.role` and a flat `modules` code list.                                                                                                                                                                                                                | `apps/auth-service/src/modules/authentication/services/token.service.ts:368-377`                                                                                                                                                                                                                                                                                                                   |
| A member's `modules` ignore whether the tenant still has the module enabled; only TENANT_ADMIN is joined to `tenant_modules.isEnabled`.                                                                                                                                                           | `token.service.ts:562-574`, `:547-561`                                                                                                                                                                                                                                                                                                                                                             |
| The one reader of `modules` only copies it.                                                                                                                                                                                                                                                       | `apps/gateway-api/src/guards/tenant-isolation.guard.ts:233`                                                                                                                                                                                                                                                                                                                                        |
| Neither the gateway's verified-user assertion nor the AI chat request has a module field, so no subgraph can decide by module.                                                                                                                                                                    | `libs/backend-common/src/http/gateway-verified-user-assertion.ts:5-33`, `apps/ai-service/src/chat/ai-chat.responder.ts:29-41`                                                                                                                                                                                                                                                                      |
| `RolesGuard` is the `APP_GUARD` of 11 services and checks `@Roles` against `users.role` through one hierarchy, hand-copied in the web.                                                                                                                                                            | `apps/farm-service/src/app.module.ts:550-554` (same in hr, sensor, alert-engine, ai, messaging, auth, notification, billing, config, hydroponics); `libs/backend-common/src/guards/roles.guard.ts:55-96`, `libs/backend-common/src/decorators/roles.decorator.ts:82-95`, `web/shared-ui/src/contexts/AuthContext.tsx:210-220`                                                                      |
| Nest runs no guard on a federation reference resolver or a field resolver. `@ResolveReference` keeps the entity type, so it takes the property-resolver path, which gets guards only through `fieldResolverEnhancers`; no service sets it. farm's reference resolver assumes the gateway decides. | `node_modules/@nestjs/graphql/dist/decorators/resolve-reference.decorator.js:11-15`, `dist/utils/extract-metadata.util.js:8-20`, `dist/services/resolvers-explorer.service.js:24-28,97-110`; `node_modules/@nestjs/core/helpers/external-context-creator.js:60-62,73`; `apps/hr-service/src/hr/department-fields.resolver.ts:12-15`; `apps/farm-service/src/farm/resolvers/farm.resolver.ts:48-56` |
| farm-service keeps its own role matrix; the site-scope manager bypass is the global role.                                                                                                                                                                                                         | `apps/farm-service/src/common/authz/permission-matrix.ts:8`, `libs/backend-common/src/security/site-authorization.service.ts:67-73`                                                                                                                                                                                                                                                                |
| Assign Manager on one module promotes `users.role` tenant-wide.                                                                                                                                                                                                                                   | `apps/auth-service/src/modules/tenant/services/tenant.service.ts:582-586`                                                                                                                                                                                                                                                                                                                          |
| Any global MODULE_MANAGER reads payroll, the HR personnel table and unmasked HR contact details.                                                                                                                                                                                                  | `apps/hr-service/src/hr/hr.resolver.ts:83-93,209-211,227-229`, `apps/hr-service/src/finance/resolvers/hr-finance.resolver.ts:106-111`                                                                                                                                                                                                                                                              |
| Farm and ST-language sockets join one `tenant:{id}` room.                                                                                                                                                                                                                                         | `apps/gateway-api/src/websocket/farm.gateway.ts:183`, `st-language.gateway.ts:202,336-338`                                                                                                                                                                                                                                                                                                         |
| nginx sends `/scada-ws/` straight to sensor-service, whose handshake takes the raw JWT role.                                                                                                                                                                                                      | `infrastructure/nginx/droplet.conf:311`, `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:221,240`                                                                                                                                                                                                                                                                                  |
| The daily feeding summary goes to every device user of the tenant.                                                                                                                                                                                                                                | `apps/notification-service/src/notification/event-handlers/feeding-daily-summary.handler.ts:192-202`                                                                                                                                                                                                                                                                                               |
| Presigned uploads check only the tenant prefix.                                                                                                                                                                                                                                                   | `apps/gateway-api/src/upload/upload.controller.ts:800-803`                                                                                                                                                                                                                                                                                                                                         |
| auth-service runs `SELECT *` over any table of the tenant's schemas.                                                                                                                                                                                                                              | `apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:1255,1320-1326`                                                                                                                                                                                                                                                                                                             |
| Farm AI queries carry only `tenantId`, no caller, and their guards reject any other key.                                                                                                                                                                                                          | `libs/event-contracts/src/farm-ai-queries.ts:91-93,146-154`                                                                                                                                                                                                                                                                                                                                        |
| Farm's NATS responders decide nothing about who asks; the broker's certificate-bound publish ACL is the only caller check, and no message field or header identifies the sender.                                                                                                                  | `apps/farm-service/src/site/responders/validate-site-assignment.responder.ts:22-28`, `apps/farm-service/src/localization/responders/resolve-time-zones.responder.ts:30-37`; `infrastructure/nats/services.yaml` (publishers of `request.farm.*`: auth 22, farm 138, sensor 232, ai 459-464 and 472-511, messaging 687)                                                                             |

Owner decisions (plan §1): Company is a read-only umbrella over the common kinds (D1); the rest is
module-private and unreachable from Company (D2); owner modules are farm, hr, sensor and
hydroponics, the last reserved and gated only (D3, D4); pay is visible only inside HR (D6).

## Decision

### 1. Six access kinds, two kinds of caller, one pure `decideAccess`

`libs/shared-contracts/src/access/decide-access.ts` (PKG-02) is the only function that answers "may
this caller do this". Guards, resolvers, NATS responders, sockets, notification fan-out and the
web nav call it. Its file header carries this table.

| Kind                                             | Protects                                                                                                                                                                      | Passes when                                                                              | Result                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `module(m)`                                      | module-private data (plan §2 table; HR pay and finance)                                                                                                                       | a member whose `moduleAccess[m]` satisfies `@Roles` (rule below)                         | allow or deny                                                                                      |
| `scoped(common-registry \| workforce \| alerts)` | registry kinds; employees and HR reads; alarm history                                                                                                                         | a member with at least one grant satisfying `@Roles`                                     | `ModuleScope` of the granted modules; an hr grant gives `ALL` for `workforce`; empty scope is deny |
| `company`                                        | Company projections only (PKG-33)                                                                                                                                             | a member holding `company:view`, and the intent is read                                  | allow; a write is always denied                                                                    |
| `self`                                           | the caller's own records (`my*`, DMs)                                                                                                                                         | an authenticated member of the tenant                                                    | allow, filtered to the caller                                                                      |
| `account(capability)`                            | tenant account administration                                                                                                                                                 | a member holding the capability                                                          | allow or deny                                                                                      |
| `service`                                        | a NATS request no member stands behind (§3 NATS requests): site labels and placement, time zones, site validity, readiness counts, the tank registry for knowledge extraction | a **service** caller that is a declared sender of the subject, with the subject's intent | allow or deny                                                                                      |

- **A caller is a member or a service.** `decideAccess` takes `Caller = UserCaller | ServiceCaller`.
  A `UserCaller` is a branded type built only from a gateway-verified identity: `@AccessCaller()`,
  the gateway's verified JWT and assertion (which already carries `assignedSiteIds`,
  `gateway-verified-user-assertion.ts:14-15`), or the member caller a service itself received on
  `request.ai.chat`, the messaging bridge or `request.ai.executeAction`; never from model output
  or a stored row. A `ServiceCaller` names one service of `infrastructure/nats/services.yaml`. A
  service caller fails every kind but `service`; a member fails `service`. NATS hands a responder
  no publisher identity and the responders read none from headers (Context), so a service is
  identified by its certificate CN (ADR-015): the broker lets only a subject's declared senders
  publish it (§Enforcement). The `service` value a request carries is checked against those
  senders and labels the deny metric; the ACL is what binds it. The precedent is ai-service's
  service principal, which runs only an exact, read-only grant and never fabricates user roles
  (`apps/ai-service/src/tools/core/tool.interface.ts:92-107`,
  `apps/ai-service/src/sensor-detection/sensor-channel-detection.responder.ts:51-55`).
- **`@Roles` values are checked by kind.** MODULE_MANAGER and MODULE_USER are satisfied only by the
  caller's module role for the spec's module, through the module-role hierarchy. TENANT_ADMIN and
  SUPER_ADMIN are account roles, satisfied only by the caller's account role and never by a module
  role. A module operation gated to TENANT_ADMIN alone, such as farm's `approveInventoryCount`,
  `archiveFinanceCategory`, `restoreFinanceCategory` and `updateFinanceSettings`
  (`apps/farm-service/src/common/authz/permission-matrix.ts:20,23,27,30`), therefore denies a farm
  MODULE_MANAGER and allows TENANT_ADMIN.
- **TENANT_ADMIN keeps full access** (plan §9 OQ1; accepting this ADR answers it): it passes
  `module(m)` for every module enabled for the tenant, gets `ALL` for every `scoped` kind and holds
  every tenant capability, `company:view` included. A TENANT_ADMIN of a tenant without hr cannot
  reach hr. SUPER_ADMIN keeps today's platform pass. Neither passes `service`.
- **In a `module-access` service (§3), a member's global role never grants module access, and a
  missing claim means no grants.** `users.role` becomes an account role (`AccountRole`);
  MODULE_MANAGER and MODULE_USER live only as values of `moduleAccess`. Nothing in such a service
  falls back to `users.role` or to `modules`. In an `account-role` service the old check stays
  until PKG-46 ends it (§3).
- **Client arguments only narrow (C2).** A `module` argument filters the server-derived scope; a
  wider request raises `ScopeWideningError`, returned as `FORBIDDEN`.
- **Company is read-only and never reaches module-private data.** There is no `company:manage`.
  Company reads projections whose DTOs hold only common fields (PKG-33). A Company-only reader is
  denied every `module(m)` operation, every `_entities` lookup of a module-private entity (`Farm`,
  `Sensor`, `SensorReading`), module socket rooms, uploads, module channels and pushes. The
  display-only `PublicUserProfile` reference stays readable inside the tenant, as for every member
  (§3).
- **A site assignment is a physical restriction** in every module where the user is MODULE_USER; a
  module's MODULE_MANAGER is tenant-wide in that module only.

### 2. The `moduleAccess` claim

| Aspect    | Rule                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape     | `Readonly<Partial<Record<OwnerModuleCode, 'MODULE_MANAGER' \| 'MODULE_USER'>>>`, `OwnerModuleCode` from the one module dictionary (PKG-01). It replaces `modules`.                                                                                                                                                                                                                                                            |
| Source    | `user_module_assignments.role` (new column, PKG-04) through one `module-access-reader`. It narrows codes with `isOwnerModuleCode` (alert, ai and unknown codes are dropped and counted) and joins `tenant_modules.isEnabled` for every kind of caller. For TENANT_ADMIN it lists every enabled module as MODULE_MANAGER.                                                                                                      |
| Backfill  | MODULE_MANAGER from `isPrimaryManager`, an upserted `tenant_modules.managerId`, or a global MODULE_MANAGER for modules other than hr; an hr MODULE_MANAGER comes **only** from `isPrimaryManager` (D6); everyone else MODULE_USER; counts logged.                                                                                                                                                                             |
| Transport | An assertion field the gateway always sends (`{}` when the caller has no grants), bound into the service-identity HMAC (`gateway-verified-user-assertion.ts:35-40`), so subgraphs can trust it. Absent means no grants; malformed is 400. The claim and `assignedSiteIds` also ride `request.ai.chat` and the messaging AI bridge, and travel as the member `caller` of every gated NATS request a member stands behind (§3). |
| Change    | `setUserModuleAccess` (PKG-06) replaces a user's grants within enabled modules and, in one transaction, invalidates tokens, writes an audit row and evicts the capability cache. Removing a module revokes the tokens of everyone holding it. This is ADR-0016's projected claim with durable invalidation.                                                                                                                   |

### 3. Enforcement order: enrolment, gateway, service guard, resolver

Each layer fails closed; no later layer widens what an earlier one decided.

**Enrolment.** `MODULE_ACCESS_ENROLMENT` (`libs/backend-common/src/security/access-enrolment.ts`,
PKG-05) is the one record of which services enforce this ADR. It is a frozen map whose keys are
the 11 services that register `RolesGuard` as `APP_GUARD` today and whose values are
`'module-access'` or `'account-role'`. Each of them registers its guards only through
`accessGuardProviders('<service>')`, whose argument is typed as a key of that map: registration
follows the entry, and a service missing from the map does not compile. PKG-05 lands every entry
as `'account-role'`. The package that classifies a service's operations flips its entry in the
same PR: hr-service (PKG-07) and farm-service (PKG-08 PR2) in R4; sensor-service (PKG-11),
alert-engine, ai-service and hydroponics-service (PKG-12) and messaging-service (PKG-25 PR2) in
R5. auth-service, billing-service, config-service and notification-service stay `'account-role'`
until a package gives their operations `@Access` specs and flips them in its own PR.

- **`account-role`:** only `RolesGuard` is registered, and it behaves exactly as today: `@Roles`
  against the token's `role`/`roles` through the one hierarchy (`roles.guard.ts:55-96`). Here
  `users.role` still decides, during R1-R5 in the services not yet enrolled and afterwards in the
  four listed above. PKG-46 is the sunset. PR1 (R5) bars MODULE_MANAGER from `@Roles` in
  `account-role` services (no resolver or controller of the four names it today) and moves every
  remaining imperative reader of `users.role` for module power to `moduleAccess`; auth-service has
  at least `apps/auth-service/src/modules/authentication/services/token.service.ts:593-599` and
  `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:1111-1114`, and
  `no-global-role-authz` finds the rest. PR2 (R6) demotes global module managers, which then
  changes no access decision. From R6 `users.role` carries no module power in any service.
- **`module-access`:** both guards of step 2 are registered and §1 holds without exception.

1. **Gateway.** Verifies the JWT and forwards `moduleAccess` to every subgraph, the AI chat path
   and the messaging bridge. It decides only on surfaces it terminates: farm and ST-language
   socket rooms (PKG-10) and `/api/upload` (PKG-43), where it decides `module('farm')` write
   itself and asks farm, as a member caller, whether this member may write documents of the target
   record (`request.farm.authorizeDocumentWrite`, below). `/scada-ws/` bypasses it, so
   sensor-service's handshake decides (PKG-11).
2. **Service guard** (root fields and REST only). `AccessClassificationGuard` denies a root
   Query/Mutation field or REST handler that has neither `@Access(...)` nor `@Public()`.
   `RolesGuard` calls `decideAccess` with the handler's spec, the intent (Mutation is write;
   Query, GET and HEAD are read; other verbs are write) and `@Roles` checked by kind (§1). It
   stores nothing on `req` and counts denials in `module_access_denied_total{service,spec_kind}`.
   Neither guard runs on a reference or field resolver (Context), so neither is relied on there.
3. **Resolver.** `@AccessCaller()` recomputes `decideAccess` from handler and class metadata plus
   `req.user` and returns a branded `AccessCaller` (`effectiveRoles`, `moduleScope`,
   `assignedSiteIds`). It throws `ForbiddenException` on deny and when neither handler nor class
   carries `@Access`, and counts the denial in the same metric. Scoped queries require a
   `ModuleScope`; reads by id assert it (`assertEmployeeInScope`, `assertRegistryRecordInScope`,
   the site assertion).
   - **Reference resolvers decide here, explicitly.** Every `@ResolveReference` in a `module-access`
     service takes the reference as `@Parent()` and `@AccessCaller()`, with read intent and the
     spec of its handler or class; none is `@Public()`. This works without guards: a method with
     parameter decorators leaves the fast field path (`resolvers-explorer.service.js:237-240`),
     Nest extracts every parameter, custom ones included, whatever the guard option
     (`external-context-creator.js:63-70,131-138`), reference arguments are normalised so the
     context is found (`node_modules/@nestjs/graphql/dist/utils/normalize-resolver-args.js:5-15`),
     and a `ForbiddenException` reaches the client as `FORBIDDEN`
     (`node_modules/@nestjs/apollo/dist/drivers/apollo-base.driver.js:18-23,193-208`; no service
     sets `autoTransformHttpErrors`). Today's references in services this ADR enrols are `Farm`
     (`apps/farm-service/src/farm/resolvers/farm.resolver.ts:56`), `Sensor` and `SensorReading`
     (`apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts:49`,
     `sensor-reading.resolver.ts:76`). The fourth is auth-service's `PublicUserProfile`
     (`apps/auth-service/src/modules/authentication/resolvers/user-federation.resolver.ts:54-64`):
     a display-only projection without email, role or tenant, looked up inside the caller's tenant
     (SEC-MEDIUM-097, `:21-27,84-95`). It is not module-private and auth-service stays
     `account-role`, so the classification rules do not apply to it; the classification spec still
     lists it and the e2e matrix tests it for every viewer (§Enforcement).
   - **Field resolvers.** An enrolled `@ResolveField` takes `@AccessCaller()` or is listed with a
     reason in `PARENT_SCOPED_FIELDS`, because no service sets `fieldResolverEnhancers`
     (`apps/hr-service/src/hr/department-fields.resolver.ts:12-15`).
   - **Paths without a GraphQL guard** call `decideAccess` at one chokepoint: a gated NATS responder
     through `REQUEST_ACCESS` (below; PKG-09, sequenced under C5 in §5); notification fan-out maps
     each event type to an `AccessSpec` and filters recipients through
     `request.auth.user.listModuleMembers` (PKG-44); socket joins go through it (PKG-10, PKG-11);
     the upload controller maps each `entityType` to an `AccessSpec` through a closed map
     (PKG-43).

**NATS requests.** `REQUEST_ACCESS` (`libs/event-contracts/src/request-access.ts`, PKG-09 PR1)
records how every gated request subject is decided: every `request.farm.*` subject,
`request.ai.executeAction`, and every request subject a package of this plan adds to a
`module-access` service. Its type is total over the union of those subjects' constants, so a
subject without an entry does not compile; the five legacy subjects that are string literals today
(`createTask`, `getTankRegistry` and the four overviews) get constants with their typed payloads
in PR1. An entry is `{ caller: 'user', spec, intent, senders }` or `{ caller: 'service', intent,
senders }`, `senders` being services.yaml names. A subject admits one caller kind, so no sender
can skip a member's decision by declaring itself a service, and no member request rides a service
grant. `SERVICE_GRANTS` (service → subject → intent) is derived from the `service` entries, never
written by hand, so the two cannot disagree. Both sit beside the subject constants because
shared-contracts cannot import event-contracts (`libs/shared-contracts/src/index.ts:11-19`); the
responder's chokepoint looks the entry up and passes it to `decideAccess`. A `service` subject
answers only with data that does not depend on a member, about ids the sender's own rows
reference; the sending service decides its own member first. No service entry has write intent.

| Subjects                                                           | Caller  | Spec and intent                                                                                                                                                          | Senders, and the release from which each sends `caller`                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the 40 `request.farm.ai.*` of `FARM_AI_QUERY_SUBJECTS`             | user    | `module('farm')`, read, plus the site scope                                                                                                                              | ai_service: `FarmAiQueryTool.run` (`apps/ai-service/src/tools/farm/farm-ai-query.tool.ts:49-56`); R4                                                                                                                     |
| `request.farm.get{Batch,Feeding,Harvest,WaterQuality}Overview`     | user    | `module('farm')`, read, plus the site scope                                                                                                                              | ai_service: `apps/ai-service/src/tools/farm/get-farm-{batches,feeding,harvest,water-quality}.tool.ts`; R4                                                                                                                |
| `request.farm.ai.getTankRegistry` (new, PR1)                       | user    | `module('farm')`, read                                                                                                                                                   | ai_service: `get-farm-tanks.tool.ts`, moved off `request.farm.getTankRegistry` (`:59`); R4                                                                                                                               |
| `request.farm.createTask`                                          | user    | `module('farm')`, write, plus the site scope                                                                                                                             | ai_service: `apps/ai-service/src/tools/farm/create-task.tool.ts:104`, carrying the turn's member or, for a confirmed proposal, the confirming member; R4                                                                 |
| `request.ai.executeAction`                                         | user    | the confirming member, checked against `confirmedBy` and passed on to `createTask`                                                                                       | messaging_service: `confirmAiAction` (`apps/messaging-service/src/ai/services/ai-chat-bridge.service.ts:390`); R4                                                                                                        |
| `request.farm.getTankRegistry`                                     | service | read                                                                                                                                                                     | messaging_service: the hourly knowledge extraction (`apps/messaging-service/src/ai/services/knowledge-extraction.service.ts:158,277,419-424`), which has no member and keeps the registry ORPHAN-MEDIUM-336 restored; R4 |
| `request.farm.resolveTimeZones`                                    | service | read                                                                                                                                                                     | sensor_service: `apps/sensor-service/src/sensor/services/series-time-zone.service.ts:194-213`, for the sites of its own sensors (`:78-88`); R4                                                                           |
| `request.farm.validateSiteAssignment`                              | service | read                                                                                                                                                                     | auth_service: `apps/auth-service/src/modules/tenant/services/farm-site-assignment-validator.service.ts:26-37`, behind the TENANT_ADMIN-gated `assignUserToSite` (`tenant-admin.resolver.ts:147-154`); R4                 |
| `request.farm.resolveSiteLabels` (PKG-08, responder R2)            | service | read                                                                                                                                                                     | sensor_service and hr_service `placementSites` (ADR-052 Decision 3); R3, their first release                                                                                                                             |
| `request.{farm,hr,sensor}.recentWriterIds` (PKG-06, responders R2) | service | read, counts only                                                                                                                                                        | auth_service readiness; R3, its first release                                                                                                                                                                            |
| `request.farm.authorizeDocumentWrite` (PKG-43, responder R3)       | user    | `module('farm')`, write, plus the site scope of the target batch or chemical; a document with no record yet (`upload.controller.ts:540-541`) needs only the module write | gateway_service upload controller; R4, its first release                                                                                                                                                                 |
| PKG-18's placement subject (ADR-052 Decision 3)                    | service | read                                                                                                                                                                     | hr_service placement authority; its first release, one after its responder                                                                                                                                               |
| PKG-23's hr AI queries (responders R7)                             | user    | set by PKG-23 for each subject in the same PR                                                                                                                            | ai_service hr tools; their first release                                                                                                                                                                                 |

So a sensor-only or hr member never needs a farm grant to see a placement: the member's own service
decides the member (sensor under `module('sensor')`, hr under `scoped('workforce')` or
`module('hr')`) and then asks farm as a service. The time-zone lookup sends a service caller
because its answer, zone names for sites sensor's own rows reference, is the same for every
member; its cache keyed by tenant and site ids (`series-time-zone.service.ts:198-204`) therefore
stays correct, and sensor decides the member's series read before it asks (PKG-11).
Service-originated AI reaches no gated subject: the only service persona, narrator-v1, has no
tools (`apps/ai-service/src/agent/personas/narrator.ts:4-8`), and a turn without a member has no
`UserCaller` to send.

A deny is `FORBIDDEN` where the reply carries an error code: the `AiQueryReply` envelope of
`request.farm.ai.*` and of every subject this plan adds, and the typed replies PR1 gives the legacy
subjects, which answer in that envelope whenever the request carries `caller`.
`validateSiteAssignment` and `resolveTimeZones` keep their reply shapes and answer a deny with their
existing refusal, `{ assignable: false }` (`validate-site-assignment.responder.ts:59-65`) and the
request-invalid error (`resolve-time-zones.responder.ts:65-68`); their senders already treat both
as a failure and fail closed. `request.ai.executeAction` answers it with `success: false`, as any
failure (`apps/ai-service/src/actions/ai-action.responder.ts:47-64`).

The web nav uses the same function: every page carries a required `layer` and `canSeePage` calls
`decideAccess` over a generated operation-access manifest (PKG-34), replacing
`web/shell/src/console/nav/pageAccess.ts:26-39`.

### 4. Viewers every package is tested against

**Role A** is a member with `{farm: MODULE_MANAGER}` and no `company:view`: all of production and
their own slices, no Company layer, no pay. **Role B** is a member with the Company Viewer role
and no grants: the Company tree, nothing module-private, no pay. **A′ and B′** add today's global
MODULE_MANAGER, which changes none of their cells (A′ sees the redacted HR directory).
**Controls:** a farm operator on site S1, an HR manager, a sensor manager on site S9,
TENANT_ADMIN, and TENANT_ADMIN of a tenant without hr.

| Surface                                                          | Role A                                 | Role B                  | TENANT_ADMIN          |
| ---------------------------------------------------------------- | -------------------------------------- | ----------------------- | --------------------- |
| batches, tanks, feeds, water quality, storage                    | allowed                                | FORBIDDEN               | allowed               |
| farm operations gated to TENANT_ADMIN (`archiveFinanceCategory`) | FORBIDDEN                              | FORBIDDEN               | allowed               |
| payroll, HR finance, labour cost (D6)                            | FORBIDDEN                              | FORBIDDEN               | allowed if hr enabled |
| workforce reads, `employee(id)`                                  | farm slice only                        | FORBIDDEN               | all                   |
| sensor resolvers, SCADA handshake                                | FORBIDDEN                              | FORBIDDEN               | allowed               |
| `_entities` for `Farm` / for `Sensor`, `SensorReading`           | allowed / FORBIDDEN                    | FORBIDDEN               | allowed               |
| `_entities` for `PublicUserProfile` (auth, `account-role`)       | own tenant only                        | own tenant only         | own tenant only       |
| alarms                                                           | farm only; passing SENSOR is FORBIDDEN | FORBIDDEN               | all                   |
| `company*` fields, `/tenant`                                     | FORBIDDEN                              | read                    | read                  |
| farm uploads, farm AI channel, farm daily summary                | allowed                                | 403, shut out, not sent | allowed               |
| farm AI tools over NATS (member caller)                          | allowed                                | FORBIDDEN               | allowed               |

### 5. Contract rules every package follows (plan §4)

| Rule                                | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Why (verified)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 Backend first                    | A field added in release N is read or sent by the web in N+1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The deploy recreates every container, waits 90 s, then restarts the gateway (`scripts/deploy/droplet-up.sh:1355-1380`).                                                                                                                                                                                                                                                                                                                                                                     |
| C2 Optional narrowing               | Client module arguments filter a server-derived scope; widening is `FORBIDDEN`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Old clients never break.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| C3 Nullable before NOT NULL         | The entity stays nullable until the release whose migration sets NOT NULL, which re-runs the backfill first. A column added in one statement as NOT NULL with a constant DEFAULT is NOT NULL from its add release (ADR-053), so its entity is non-null in that release.                                                                                                                                                                                                                                                                                                                                                                                             | Non-null entity over a nullable column is fatal drift class C (`libs/backend-common/src/database/schema-drift/drift-classes.ts:113-121`).                                                                                                                                                                                                                                                                                                                                                   |
| C4 Orphan first, then drop          | Release N unmaps (class E, warning); release ≥ N+1 drops with `dropOrphanedColumns`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Old containers still read it; precedent `apps/hr-service/src/database/migrations/1802500000000-RetireEmployeeLegacyDepartment.ts:76-77`.                                                                                                                                                                                                                                                                                                                                                    |
| C5 Order between services           | A NATS responder accepts a subject or a request field at least one release before any caller sends it, and requires a new field only in a release after every caller sends it. A subject created after the field exists requires it from its first release, since it has no older caller. An event consumer ships before its producers.                                                                                                                                                                                                                                                                                                                             | No mixed-version pair fails: an old responder never meets an unknown key from a new caller, and a new responder never requires a key an old caller omits. Request guards check exact keys (`farm-ai-queries.ts:146-154`; `farm-site-access-queries.ts:25-32`; `farm-time-zone-queries.ts:41-54`).                                                                                                                                                                                           |
| C6 Rollback where a defect needs it | (a) A release that switches on access enforcement (a service flipping to `module-access`, a socket, upload, fan-out or NATS access gate, a reader of module power moved off `users.role`) carries no migrations: R4, R5. (b) A BREAKING GraphQL change that a web or aquamobil client of the previous release still uses (a rename, a removal, a newly required input or a newly refused value) carries no migrations. (c) A BREAKING GraphQL change that no client of the previous release uses may share a release with migrations: its callers switched in an earlier release, its PR names that release, and `codegen:check` proves no current document breaks. | The deploy refuses an image rollback once a release applied any migration (`scripts/deploy/lib/release-rollback.sh:224-236`; count recorded at `droplet-up.sh:342-356`). A class (c) change breaks only clients older than the previous release: the web reloads through PKG-42's skew reload, and PKG-42 lists for re-entry every offline replay rejected with a code in `PERMANENT_GRAPHQL_ERROR_CODES` (`web/apps/aquamobil/src/pwa/graphql-replay-error.ts:24-31`), not only FORBIDDEN. |
| C7 Data-dependent steps stand alone | Orphan-FK validation, NOT NULL on counted data and uuid casts each get their own migration and PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Each merges only after the operator counts are zero.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| C8 Keep files short                 | New logic goes into new files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `tenant-admin.service.ts` (1421 lines), `token.service.ts` (886), `farm.gateway.ts` (541) do not grow.                                                                                                                                                                                                                                                                                                                                                                                      |

**PKG-09 under C5.** Three PRs; the senders are those of the §3 NATS table.

- **PR1 (R2, moved from R3; no migrations; nothing denied).** `REQUEST_ACCESS` and its derived
  `SERVICE_GRANTS`; the `caller` wire type and guard; the responder chokepoint; and the typed sender
  `libs/backend-common/src/nats/gated-request.ts`, whose required `caller` parameter is a
  `UserCaller` for a user subject and the sending service's own `ServiceCaller` for a service
  subject. Every existing gated request guard, `request.ai.executeAction`
  (`ai-action.responder.ts:43`) included, accepts an optional `caller` and validates it when
  present; a malformed one or one of the wrong kind is `INVALID_REQUEST`. `FORBIDDEN` joins the
  reply unions (today `farm-ai-queries.ts:95,156-160` allows only `INVALID_REQUEST` and
  `INTERNAL_ERROR`), and the legacy subjects answer in the envelope whenever `caller` is present.
  The `request.farm.ai.getTankRegistry` responder and its grants ship here. PR1 is in R2 because
  the R2 responders of PKG-06 and PKG-08 are born requiring `caller` (C5) and need its contract.
  No deployed sender sends `caller` yet, so nothing is denied.
- **PR2 (R4, merged after PKG-08 PR2).** Every sender that predates PR1 sends `caller` through the
  typed sender: the ai-service tools, messaging's `confirmAiAction` and knowledge extraction,
  sensor-service's time-zone lookup and auth-service's site-assignment check, each with the caller
  kind of its subject. The responders apply `decideAccess`, and for a member the site scope,
  whenever `caller` is present, and answer a deny as §3 says. Only senders that send `caller` can
  be denied, and each was written against the deny reply. From this PR `farm-nats-caller.spec.ts`
  fails any sender of a gated subject under `apps/` that does not send through the typed sender,
  so a missed sender fails CI in R4, a release before PR3 requires the field. The senders born
  after PR1 (PKG-06 readiness and PKG-08 `placementSites` in R3, PKG-43's upload in R4, PKG-18,
  PKG-23) use the typed sender from their first release, so they cannot omit `caller`.
- **PR3 (R5).** `caller` is required; absent is `INVALID_REQUEST`. ai_service loses its publish
  grant on `request.farm.getTankRegistry` (unused since R4), and farm_service its publish grant on
  `request.farm.validateSiteAssignment` (`infrastructure/nats/services.yaml:138`), which nothing
  under `apps/`, `scripts/` or `tools/` sends from farm. From R5 the publishers of every gated
  subject are exactly its declared senders.

This replaces the plan's same-release step for PKG-09.

**BREAKING GraphQL changes under C6.** Every one in the plan, with its class:

| Release                         | Migrations | Change                                                                                                                                                                               | Class | Callers switched                                                                                                                                                        |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2                              | none       | one GraphQL `OwnerModule` (PKG-01 PR2)                                                                                                                                               | (b)   | web and aquamobil in the same release                                                                                                                                   |
| R3                              | yes        | `assignUserToModule`, `removeUserFromModule` deleted (PKG-06 PR1)                                                                                                                    | (c)   | no document under `web/` calls them (`apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts:116,128`)                                                 |
| R4                              | none       | `managerId` and assignment `permissions` fields removed (PKG-06 PR2, moved from R3)                                                                                                  | (c)   | the web stops reading `managerId` in R3 (`web/modules/tenant-admin/src/graphql/module-queries.ts:44,82,92`)                                                             |
| R4                              | none       | Assign / Remove Manager refuse a module that owns no data (alert, ai), which R3 still designates in `managerId` alone when the module id names it (PKG-06 PR2, moved from PR1 in R3) | (b)   | the web offers manager actions only on owner modules and names them by module code in the same release (PKG-06's console, one release after PR1 adds the fields, C1)    |
| R6, R7                          | yes        | `updateHRDepartment` refuses a null module (PKG-18 PR1); `createHRDepartment` requires one (PKG-18 PR2) (`apps/hr-service/src/hr/hr.resolver.ts:299,314`)                            | (c)   | the web, which sends `null` for company-wide today (`web/modules/hr-module/src/pages/DepartmentsPage.tsx:36-42,86-93`), drops that option in R5 (moved from PKG-18 PR2) |
| R7                              | yes        | auth raw-table readers deleted (PKG-45 PR2b)                                                                                                                                         | (c)   | the web switches to the sensor readers in R6 (PKG-45 PR2a, moved from R7)                                                                                               |
| R8                              | yes        | registry create inputs require `moduleCode` (PKG-15; ADR-052 Consequences)                                                                                                           | (c)   | the web and aquamobil send `moduleCode` on every registry create from R7 (PKG-13 PR2), one release after PKG-13 PR1 adds the optional input                             |
| R10                             | none       | `Employee.farmId` removed (PKG-29)                                                                                                                                                   | (c)   | the web stops requesting it in R9 (PKG-28)                                                                                                                              |
| own release between R12 and R13 | none       | workers UI and API removed together (PKG-37 W3, moved out of R12)                                                                                                                    | (b)   | the same release                                                                                                                                                        |

## Enforcement

The invariants are new and run on every PR (plan §7), except where a row names an existing spec.

| Test                                                                                                            | What it pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Package                                        |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `tests/invariants/module-dictionary-ssot.spec.ts` (replaces `hr-module-code-parity.spec.ts`)                    | No module-literal union outside the dictionary; GraphQL enum and replayed Postgres labels equal it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | PKG-01                                         |
| `libs/shared-contracts/src/access/__tests__/decide-access.spec.ts`, `module-scope.spec.ts`                      | Every §4 viewer × kind × intent × claim shape; `@Roles` checked by kind, including a TENANT_ADMIN-only farm mutation (farm MODULE_MANAGER denied, TENANT_ADMIN allowed); narrowing never widens; a Company write is denied. Service callers: a declared sender passes `service` with the entry's intent and fails it for a subject it does not send, for a write intent and for every other kind; every member, TENANT_ADMIN and SUPER_ADMIN included, fails `service`.                                                                                                                                      | PKG-02                                         |
| `tests/invariants/role-hierarchy-single-owner.spec.ts`                                                          | One role hierarchy, in parity with `Role`; no backend or web copy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PKG-02                                         |
| `tests/invariants/tenant-capability-usage.spec.ts`                                                              | The catalogue holds only enforced keys plus `company:view`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | PKG-03                                         |
| `tests/invariants/module-access-guard-adoption.spec.ts`                                                         | The keys of `MODULE_ACCESS_ENROLMENT` equal the services that register `RolesGuard`; each registers its guards only through `accessGuardProviders(<its key>)`; no `app.module.ts` constructs `RolesGuard` directly.                                                                                                                                                                                                                                                                                                                                                                                          | PKG-05                                         |
| `tests/invariants/module-access-classification.spec.ts`                                                         | In every `module-access` service: each root field and REST handler has `@Access` or `@Public`; each `@ResolveReference` takes `@Parent()` and `@AccessCaller()`, has `@Access` on handler or class and no `@Public`; each `@ResolveField` takes `@AccessCaller()` or is in `PARENT_SCOPED_FIELDS` with a non-empty reason, and an entry naming no field fails; `Access.module` names the service's own module; `Access.company` only on Query under `*/company-layer/`. It also emits every `@ResolveReference` of every service, with the service's enrolment, for the e2e matrix.                          | PKG-05                                         |
| `libs/backend-common/src/guards/__tests__/roles.guard.access.spec.ts`                                           | `account-role` mode keeps today's outcomes (the cases of `roles.guard.ts:55-96`); `module-access` mode calls `decideAccess` with `@Roles` checked by kind; the guard leaves `req` unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                 | PKG-05                                         |
| `libs/backend-common/src/security/__tests__/access-caller.aliased-operation.spec.ts`                            | One request aliasing two root fields with different specs: each `AccessCaller` holds only its own field's scope. A denied `@ResolveReference` and `@ResolveField` throw `FORBIDDEN` with no guard registered for them, and a handler without `@Access` is denied.                                                                                                                                                                                                                                                                                                                                            | PKG-05                                         |
| `tests/invariants/no-global-role-authz.spec.ts`                                                                 | Its service list comes from `MODULE_ACCESS_ENROLMENT`. In a `module-access` service no authorization reads `users.role` or `modules` for module power, from the PR that flips it. From PKG-46 PR1 no `@Roles` in an `account-role` service names MODULE_MANAGER and no imperative check anywhere reads `users.role` for module power.                                                                                                                                                                                                                                                                        | PKG-05, 07, 08, 11, 12, 25, 46                 |
| `tests/invariants/hr-finance-module-boundary.spec.ts`                                                           | Pay and HR finance require an hr grant (D6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | PKG-07                                         |
| `tests/invariants/farm-nats-caller.spec.ts`                                                                     | `REQUEST_ACCESS` is complete: every `request.farm.*` subject granted in services.yaml or answered under `apps/farm-service`, `request.ai.executeAction` and every subject a package adds to a `module-access` service has an entry. Every responder of a gated subject decodes through its contract guard and calls the one chokepoint before it reads. From PKG-09 PR2 every sender of a gated subject under `apps/` sends through the typed sender, and a `ServiceCaller` literal equals the services.yaml `name` of the app that sends it and is a declared sender. From PR3 the guards require `caller`. | PKG-09 PR1, then each package adding a subject |
| `tests/invariants/request-reply-contract-acl.spec.ts` (existing, extended)                                      | For every `REQUEST_ACCESS` entry, the owner subscribes and each declared sender holds the publish grant; from PKG-09 PR3 no other service may publish the subject, so the certificate-bound ACL (ADR-015) equals the declared senders. Its hand-written farm `callers` (`:34-47`) are read from `REQUEST_ACCESS` instead.                                                                                                                                                                                                                                                                                    | PKG-09 PR1, PR3                                |
| `tests/invariants/ws-module-scoped-rooms.spec.ts`                                                               | Every `@WebSocketGateway` and nginx-routed socket path joins only module or site rooms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | PKG-10                                         |
| `apps/gateway-api/src/upload/__tests__/upload-access.spec.ts`                                                   | The `entityType` → `AccessSpec` map is closed (an unknown type is 403); chemical and batch documents need farm write intent plus farm's `request.farm.authorizeDocumentWrite` for the member caller (the S1 operator is refused an S2 batch); `telemetry-archive` maps to sensor; role B gets 403 on every `/api/upload` route.                                                                                                                                                                                                                                                                              | PKG-43                                         |
| `tests/invariants/notification-fan-out-access.spec.ts`                                                          | Every handler under `apps/notification-service/src/notification/event-handlers/` has an entry in the typed event-type → `AccessSpec` map and resolves recipients only through `listModuleMembers`.                                                                                                                                                                                                                                                                                                                                                                                                           | PKG-44                                         |
| `tests/invariants/operation-access-manifest-fresh.spec.ts` + viewer property spec                               | The manifest matches the code; no viewer sees a page `decideAccess` denies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | PKG-34                                         |
| `tests/invariants/company-layer-projection.spec.ts`                                                             | No Company DTO contains a module-private field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | PKG-33                                         |
| `tests/invariants/contract-drop-orphan-first.spec.ts`                                                           | A dropped column is absent from the entities on the merge base.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | C4                                             |
| `e2e/tests/security/module-access-layers.matrix.ts` → `module-access-layers.spec.ts`, `header-spoofing.spec.ts` | Generated cells: every root operation of the PKG-34 manifest × every §4 viewer, and every reference resolver the classification spec lists × every §4 viewer, sent as `_entities` to its subgraph with that viewer's gateway-signed assertion, as the router does (`PublicUserProfile` expects own-tenant results only); an invariant requires a cell for each. Forged `moduleAccess` rejected; after revocation FORBIDDEN within one access-token TTL, sockets dropped within 60 s.                                                                                                                         | PKG-05, 41                                     |

**What the generated matrix does not cover, and where it is tested.** It generates GraphQL root
operations and `_entities` only. Field resolvers are covered by
`module-access-classification.spec.ts` and their parent operation's cell. Gated NATS subjects are
covered by `farm-nats-caller.spec.ts`, the extended `request-reply-contract-acl.spec.ts` and the
PKG-09 specs (an S1 operator asking about S2, a confirm after the grant was revoked, a member
caller on a service subject and a service caller on a member subject both `INVALID_REQUEST`);
sockets by `ws-module-scoped-rooms.spec.ts` and the PKG-10 and PKG-11 room specs; pushes and
in-app notifications by `notification-fan-out-access.spec.ts` and the PKG-44 specs; `/api/upload`
by `upload-access.spec.ts`; messaging module and AI channels by the PKG-25 specs; the raw-table
readers by the PKG-45 allowlist spec and its auth-SQL invariant. PKG-41 adds hand-written cells in
`e2e/tests/integration/module-access-layers.spec.ts` for roles A and B and TENANT_ADMIN on each of
these surfaces (plan §7 mandatory cells). The invariants make each surface complete; the e2e cells
prove it on the deployed stack.

After every deploy `module_access_denied_total` is read per service. A deny spike is fixed by
granting access through PKG-06, never by loosening a guard. A service-caller deny is a defect in
`REQUEST_ACCESS` or the ACL, fixed there.

## Implementation packages

| Package | Release    | Part of this decision                                                                                                                                                                                                                                                        |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PKG-01  | R1, R2     | One module dictionary; one GraphQL `OwnerModule` (R2, BREAKING).                                                                                                                                                                                                             |
| PKG-02  | R1         | `AccessSpec` with the `service` kind, the member/service `Caller`, `decideAccess`, `ModuleScope`, single role hierarchy, capability literal.                                                                                                                                 |
| PKG-03  | R1, R2     | `company:view`, Company Viewer template, role editor stores keys, inert keys removed.                                                                                                                                                                                        |
| PKG-04  | R1, R2     | `moduleAccess` minted and carried (assertion, AI chat, bridge); role column and backfill.                                                                                                                                                                                    |
| PKG-05  | R1         | `@Access`, `MODULE_ACCESS_ENROLMENT` (all `account-role`) and `accessGuardProviders`, access-aware `RolesGuard`, classification guard, `@AccessCaller`, deny metric, matrix.                                                                                                 |
| PKG-06  | R2, R3, R4 | `request.{farm,hr,sensor}.recentWriterIds` responders (R2); admin path; Assign Manager by module code (deletes `tenant.service.ts:582-586`); revocation; readiness counts, sent as auth_service (R3); role NOT NULL (R3); `managerId` and `permissions` fields removed (R4). |
| PKG-07  | R4         | hr-service enrolled: D6, server-derived workforce scope, `self`, audit redaction.                                                                                                                                                                                            |
| PKG-08  | R2, R3, R4 | `resolveSiteLabels` responder (R2); `placementSites` service callers (R3); farm-service enrolled and `PermissionMatrixGuard` retired (R4).                                                                                                                                   |
| PKG-09  | R2, R4, R5 | `REQUEST_ACCESS`, typed sender, NATS caller accepted (R2), sent and decided (R4), required with the ACL equal to the declared senders (R5).                                                                                                                                  |
| PKG-10  | R4         | Module and site socket rooms; revoked sockets disconnected.                                                                                                                                                                                                                  |
| PKG-11  | R5         | sensor-service enrolled; the SCADA socket enforced.                                                                                                                                                                                                                          |
| PKG-12  | R5         | alert-engine, ai-service and hydroponics-service enrolled: alert scope, persona module gate, hydroponics class gate.                                                                                                                                                         |
| PKG-34  | R10        | Nav access contract on the generated manifest; web hand matrices deleted.                                                                                                                                                                                                    |
| PKG-43  | R3, R4     | farm's `request.farm.authorizeDocumentWrite` responder and gateway_service's publish grant (R3); upload controller follows the module, unknown entity types are 403 (R4).                                                                                                    |
| PKG-44  | R3, R5     | Notification fan-out by module.                                                                                                                                                                                                                                              |
| PKG-45  | R5, R6, R7 | Raw tables served by sensor-service from a closed allowlist (R5); web switched (R6); auth SQL readers deleted (R7).                                                                                                                                                          |
| PKG-46  | R5, R6     | Remaining `users.role` readers of module power moved to `moduleAccess` (R5); global module managers demoted (R6).                                                                                                                                                            |

R4 is the first enforcing release. Its gate: readiness counts zero or owner sign-off, OQ4 answered,
and a notice telling field users to sync offline queues.

## Plan amendments

Accepting this record changes the plan's wording as below; PKG-00 edits the plan and ADR-052 to
match.

- **§2 access kinds** (`company-plan.md:42-47`): add `service`, a NATS request no member stands
  behind, passed only by a declared sender of the subject; `decideAccess` takes a member or a
  service caller.
- **PKG-06** (`:226`): the three `recentWriterIds` responders ship in R2, merged after PKG-09 PR1,
  and require a service `caller` from birth; auth's readiness sends from R3 as auth_service, whose
  publish grants land with the responders. `managerId` and `permissions` removal moves to R4 (§5).
- **PKG-08** (`:268`): the `resolveSiteLabels` responder ships in R2 (ADR-052), merged after PKG-09
  PR1, and requires a service `caller` from birth; sensor-service's and hr-service's
  `placementSites` send one from R3, with their publish grants landing alongside the responder.
- **PKG-09** (`:294-304`): "a service, with SERVICE_GRANTS empty" (`:298`) becomes `REQUEST_ACCESS`
  with its `service` entries and the derived `SERVICE_GRANTS` (§3); "farm-service and ai-service
  ship in the same release" (`:303`) becomes PR1 in R2, PR2 in R4 and PR3 in R5 (§5). Files add
  `libs/event-contracts/src/request-access.ts`, `libs/backend-common/src/nats/gated-request.ts`,
  the `request.farm.ai.getTankRegistry` responder and
  `tests/invariants/request-reply-contract-acl.spec.ts`. Accept becomes: no gated subject answers
  without a validated caller, and from R5 no service but its declared senders can publish it.
- **PKG-43** (`:286-291`): `request.farm.validateSiteAssignment` becomes the new member subject
  `request.farm.authorizeDocumentWrite`. The upload bodies carry a `chemicalId` or an optional
  `batchId` and no site (`upload.controller.ts:186-192`,
  `apps/gateway-api/src/upload/dto/upload-batch-document.dto.ts:34-36`), and
  `validateSiteAssignment` answers only whether a given site is active in the tenant
  (`libs/event-contracts/src/farm-site-access-queries.ts:1-19`), so it cannot refuse an S1
  operator's document on an S2 batch. Deps add 09; PR1 (R3) ships farm's responder with
  farm_service's subscribe and gateway_service's publish grant in
  `infrastructure/nats/services.yaml`, whose gateway entry has no `request.farm.*` subject today
  (`:392-407`); PR2 (R4) is the controller.
- **PKG-18, PKG-37, PKG-45, PKG-46**: the release moves of §5 (BREAKING table) and §3.
- **§6 rollout table** (`:602-608`): R2 adds 06 responders, 08 PR1 responder and 09 PR1; R3 adds 43
  PR1; R4 adds 09 PR2; R5's "NATS caller required (farm and ai together)" becomes "NATS caller
  required; each gated subject published only by its declared senders".

## Consequences

- One function owns every access answer; a new module or viewer is a dictionary entry and a table
  row proved by `decide-access.spec.ts`. An unclassified root operation is denied by the guard and
  an unannotated reference or field resolver fails the classification invariant, so a new resolver
  cannot ship open. The cost is an `@Access` on every handler, `@AccessCaller()` on every
  reference and field resolver that is not parent-scoped, and a recurring review of
  `PARENT_SCOPED_FIELDS`. The global `APP_GUARD`s plus the adoption invariant replace per-method
  `@UseGuards(RolesGuard)` in enrolled services; ADR-008's double registration in
  admin-api-service is unchanged.
- A new gated NATS subject is an entry in `REQUEST_ACCESS` before it compiles, and its broker grant
  follows the entry. A service grant is a reviewed line of code and a services.yaml grant, never an
  implicit pass.
- One map says which services enforce; during R1-R5 an `account-role` service still lets
  `users.role` decide, by design, and PKG-46 ends that in R5-R6.
- Tokens minted before R1 carry no `moduleAccess` and mean no grants; enforcement waits for R4,
  after the R2 gate (one token TTL elapsed, mint metric at 100%).
- Lockout on enforcement day is the main risk, bounded by OQ4's counted backfill, the readiness
  report, the deny metric and PKG-42's replay listing (FORBIDDEN is permanent in
  `web/apps/aquamobil/src/pwa/graphql-replay-error.ts:24-31`). R4 and R5 carry no migrations, so a
  defective guard is rolled back by image.
- PKG-09 has no failing mixed-version pair. From R2 farm accepts `caller` and answers in the
  envelope when it is present; in R4 a new sender meets an R2-R4 farm that accepts it; in R5 farm
  requires a field every sender has sent since R4, and subjects born after R2 required it from
  their first release. PKG-06, PKG-08, PKG-09, PKG-18, PKG-37, PKG-43, PKG-45 and PKG-46 gain a
  release step each (§5, Plan amendments); PKG-37 W3 takes a release of its own.
- The member caller is trusted as far as its sender: a service holding a member subject's publish
  grant could forge a member. The grant set is closed and reviewed (ai_service, messaging_service
  and gateway_service only, each forwarding an identity the gateway verified), which is what "AI
  tools never read more than the human caller could" needs; it does not defend against a
  compromised sender.

## Alternatives considered

- **Keep `modules` and use `users.role` as the level.** Rejected: one role spans every module, so
  a farm manager reads payroll (`tenant.service.ts:582-586`, `hr.resolver.ts:209-211`); D2 and D6
  cannot hold.
- **Decide only at the gateway.** Rejected: `/scada-ws/` never crosses it (`droplet.conf:311`),
  and the NATS AI path and notification fan-out have no gateway hop. Each owner decides with the
  same function.
- **Run the global guards on reference and field resolvers (`fieldResolverEnhancers: ['guards']`).**
  Rejected. It turns guards on for every `@ResolveField` and `@ResolveReference` of a service
  (`resolvers-explorer.service.js:97-110`) and disables the fast field path for all of them
  (`:220-225`), so every `APP_GUARD` runs once per resolved field per row. In farm-service that
  includes `ServiceIdentityGuard`, `TenantGuard` and the distributed `ThrottlerGuard`
  (`apps/farm-service/src/app.module.ts:536,546,565`), which consumes a rate-limit token on every
  call (`libs/backend-common/src/security/throttler/throttler.guard.ts:78,103`): a list of N rows
  would spend N rate-limit tokens per field. `AccessClassificationGuard` would also deny every
  field resolver without `@Access`. `@AccessCaller()` decides once per resolver that needs it, and
  the classification invariant covers the rest.
- **Store the guard's decision on `req` for the resolver.** Rejected in review: sibling root
  fields share one `req` and Nest awaits the guard before the pipes
  (`node_modules/@nestjs/core/helpers/external-context-creator.js:60-74`), so an aliased field
  could read another field's decision. `@AccessCaller()` recomputes instead.
- **Enrol every service at once in PKG-05.** Rejected: the classification guard would deny every
  unannotated operation of every service on R1, before any grant exists. Enrolment follows the
  package that classifies the service, recorded in one map.
- **Ship the farm responders and their callers in one release (plan PKG-09 as first written).**
  Rejected under C5: the exact-key guards reject the new field in one direction and require it in
  the other, so AI farm tools would fail while versions mix.
- **Trust a service identity carried in the request or a header.** Rejected: core NATS gives a
  responder no publisher identity, and the responders deliberately read none from forgeable
  headers (`validate-site-assignment.responder.ts:26-27`); only the certificate-bound publish ACL
  identifies a service (ADR-015). The `service` value is checked against the declared senders, but
  the ACL binds.
- **Let one subject take both member and service callers** (`request.farm.getTankRegistry` serves
  the AI tool and the extraction today). Rejected: any service holding the publish grant could
  then claim the service caller and skip the member's decision. One kind per subject lets the ACL
  bind it, so the AI tool moves to `request.farm.ai.getTankRegistry`.
- **Send the member on the time-zone, label and site-validity lookups.** Rejected: their answers
  do not depend on the member. Sensor's cache keyed by tenant and sites
  (`series-time-zone.service.ts:198-204`) would serve one member's decision to every other, or a
  per-member cache would multiply farm calls for the same answer; the sending service decides its
  member before it asks.
- **Write `SERVICE_GRANTS` by hand next to `decideAccess`.** Rejected: a second hand-written list of
  service subjects drifts from the subject map; it is derived from `REQUEST_ACCESS`, which lives
  beside the subject constants that shared-contracts cannot import.
- **Move every BREAKING GraphQL change into a release without migrations.** Rejected: ADR-052 opens
  non-farm registry writes in R8, and from R7 a registry insert without a module fails (ADR-052
  decision 2), so the required create input belongs to R8, which carries migrations. C6 (c) instead
  requires that no client of the previous release uses what changes.
- **Keep farm's `PermissionMatrixGuard` and add matrices per service.** Rejected: a second
  classification owner per service drifts; its ungated list moves into the classification invariant.
- **Trust the client's `module` argument.** Rejected (C2): the server derives the scope.
- **Let Company read module resolvers, or add `company:manage`.** Rejected: Company reads dedicated
  projections only; writes belong to the owning module (D1, D2).
- **Require explicit grants for TENANT_ADMIN.** Rejected by OQ1: the administrator already receives
  every enabled module (`token.service.ts:547-561`); the D2 Company role is role B.
- **Derive an hr manager grant from the global MODULE_MANAGER.** Rejected: it gives pay to every
  legacy manager (D6).
- **Filter the auth `SELECT *` reader with a denylist.** Rejected: a denylist fails open on every
  new table; PKG-45's closed allowlist fails closed.

## Carried to implementation

The architectural-arbiter approved this ADR on 2026-10-26 with five minor points. They bind the
packages that implement it and are checked in their review:

1. Transport per subject (PKG-09 PR1). The typed sender `gated-request.ts` keeps each subject's
   current transport. The farm.ai queries, the four overviews, createTask, getTankRegistry and
   request.ai.executeAction use Nest ClientProxy (packets carry pattern, data and id; responders
   are `@MessagePattern`); validateSiteAssignment and resolveTimeZones use NatsRequestReply (plain
   JSON). A Nest NATS server treats a message without an id as an event and sends no reply, so
   moving a subject to the other transport is its own change, ordered by C5: the responder accepts
   both formats for one release before any sender switches. REQUEST_ACCESS records the transport
   of each subject and `farm-nats-caller.spec` asserts that each sender uses it.
2. Seven legacy literals. createTask, getTankRegistry, the four overviews and
   request.ai.executeAction are string literals today. All seven get constants and typed payloads
   in PKG-09 PR1.
3. The executeAction row names its AccessSpec. The probable choice is `self` with write intent,
   plus the rule that the caller's subject equals `confirmedBy`; the farm module write and site
   decision belong to farm on the createTask request that carries the same member. A
   decide-access or responder spec row covers it.
4. getTankRegistry as a service subject. It answers with every tank of the tenant, which are
   farm-private (D2), against the section 3 rule that a service subject answers only about ids
   the sender's own rows reference. Preferred: narrow it to a bounded lookup from the codes found
   in the batch's messages to `{id, code}`, built like resolveSiteLabels (a maximum count and
   exact-key guards). Otherwise the full-registry answer is recorded as a named exception to the
   rule and justified under D2.
5. PKG-21 census subjects and mechanical completeness. The count-only census responders that
   PKG-21 adds to sensor-service and hr-service are gated service subjects with farm_service as
   sender, sent from their first release; they get a row in the section 3 table. Completeness is
   defined mechanically: every request subject that a module-access service subscribes to in
   `infrastructure/nats/services.yaml` has a REQUEST_ACCESS entry or appears in a frozen
   PRE_PLAN_UNGATED_SUBJECTS list with a reason. The section 6 amendment also moves PKG-06's
   managerId and permissions removal from R3 to R4 and adds PKG-06 PR2 and PKG-43 PR2 to R4.
