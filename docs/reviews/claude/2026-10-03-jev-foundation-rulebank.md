# Foundation rule bank (Jev) — verified defects (2026-10-03)

Context: the Jev (TypeSafe System One) rule bank for the layers the platform stands on — auth, RBAC, tenant
sourcing, database tenant context, NATS and nginx. Each rule pairs deterministic facts (regex over the unit) with
atomic English questions to Jev; a flag is a lead, not a verdict. Every finding below was read in code at
`c1d183969` (auth flags by an auth-security-expert pass over a 58-flag sample, the rest by hand) before registration.
Rule banks and runner live outside the repository (operator rule: the Jev key and tooling stay off GitHub).

Owner: the domain agent named per finding (implementation), okan (review). Deadlines: HIGH 2026-10-17,
MEDIUM 2026-10-31, LOW 2026-11-30.

Precision of the first live auth scan (58 sampled flags): 16 real (9 full, 7 minor), 42 false — mostly the
unit cut (a fixed window instead of the method) and guards that live in the caller; both are runner fixes, not
rule changes, and the bank is not used as a gate until a fresh sample clears it.

## RBAC-HIGH-017 — updateRole writes a role's level with no ceiling check, so a delegate holding roles:edit can raise its own role's level and with it the ceiling assertRoleGrantAuthority grants against

Rule: AUTH-R06. Evidence at `c1d183969`:

- `apps/auth-service/src/modules/tenant/services/tenant-role.service.ts:611-636` — only panelPermissions are checked against the editor's authority
- `apps/auth-service/src/modules/tenant/services/tenant-role.service.ts:713-716` — input.level is written unchecked; DTO bounds only 1..100
- `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts:475-488` — the grant ceiling is the actor's highest role level

Invariant: An actor may not change any value that its own authorization is computed from; a role's level is bounded by the editor's ceiling exactly as its capabilities are.

A non-admin delegate with `roles:edit` edits its own role (or any role it holds) to `level = 100`, then assigns itself or others any role up to level 100 — including roles whose capabilities it does not hold — because `assertRoleGrantAuthority` compares the target role's level with the actor's (now raised) ceiling. RBAC-C2 closed the capability vector of role authoring; the level vector stayed open.

Fix direction: Bound `level` in `updateRole` (and `createRole`) by the editor's ceiling through the same capability-authority service that brands panelPermissions, so the only `level` the UPDATE accepts is a branded, ceiling-checked value (tier 1).

## RBAC-MEDIUM-018 — updateTenantUser writes accessType (mobile access, mobileFeatures claims) for any target user including the actor itself; the self/ceiling guard covers only the roleId branch

Rule: AUTH-R06. Evidence at `c1d183969`:

- `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts:223-279` — accessType branch, no self or ceiling check
- `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts:304` — assertRoleGrantAuthority guards the roleId branch only
- `apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts:334-360`

Invariant: Every privilege-bearing field of a user update passes the same actor-vs-target authority check, not only the role.

An actor allowed to update tenant users can toggle `isMobileEnabled` and the `mobileFeatures` token claims for itself or for a higher-level admin, because the authority check sits inside the role branch.

Fix direction: Run the actor-vs-target authority check once at the top of the update for any privilege-bearing field (role, accessType, overrides), not per branch.

## SEC-HIGH-189 — Gateway upload endpoints delete chemical and batch documents with no role or permission gate: any authenticated principal of the tenant can delete them

Rule: AUTH-R05. Evidence at `c1d183969`:

- `apps/gateway-api/src/upload/upload.controller.ts:343-372` — deleteChemicalDocument: no @Roles/permission decorator
- `apps/gateway-api/src/upload/upload.controller.ts:616-699` — deleteBatchDocument: same; entityId is free text in the storage path at :670-675
- `apps/gateway-api/src/app.module.ts:542-607` — global guards are AuthGuard, TenantIsolationGuard, RateLimitGuard only
- `infrastructure/nginx/droplet.conf:388` — /api/upload/ is routed to the gateway

Invariant: A destructive endpoint carries an explicit role or permission gate; authentication alone is not authorization.

A read-only or operator user can delete regulatory chemical documents (SDS) and batch documents of its tenant. Tenant isolation holds; role isolation does not.

Fix direction: Gate the upload controller's mutating routes with the same permission vocabulary the owning subgraph uses for the entity (chemical, batch), and add an invariant that every gateway REST mutation declares a gate.

## SEC-MEDIUM-190 — acceptInvitation and resetPassword mint sessions without the tenant-status gate (isLoginAllowed), so users of a suspended, deactivated or cancelled tenant still get access tokens

Rule: AUTH-R09. Evidence at `c1d183969`:

- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:913-1025` — acceptInvitation mints at :1025, no isLoginAllowed
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:1927-2065` — resetPassword mints at :2065, no isLoginAllowed
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:612-633` — login carries the gate
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:321-333` — refresh carries the gate; RBAC-HIGH-007

Invariant: Every token-mint path enforces the tenant-status machine; the gate belongs to the single mint authority, not to each caller.

RBAC-HIGH-007 added the gate to login and refresh. The two other mint paths kept minting. The recurrence pattern (ADMIN-HIGH-014/015 were the same shape for MFA and session clamps) shows per-caller gates drift.

Fix direction: Move the tenant-status check into the token-mint authority (tokenService.generateTokens or a branded MintableUser it requires), so no path can mint for a non-operational tenant (tier 1).

## SEC-MEDIUM-191 — MFA step-up, MFA login, WebAuthn login and consent recording take the client IP from req.ip or the leftmost X-Forwarded-For instead of resolveClientNetworkContext, and persist it

Rule: AUTH-R16. Evidence at `c1d183969`:

- `apps/auth-service/src/modules/authentication/resolvers/mfa.resolver.ts:220-221` — mfaStepUp
- `apps/auth-service/src/modules/authentication/resolvers/mfa.resolver.ts:264-265` — verifyMfaLogin
- `apps/auth-service/src/modules/authentication/resolvers/webauthn.resolver.ts:196-197` — stored as lastLoginIp, webauthn.service.ts:439, and in audit :446-450
- `apps/auth-service/src/modules/gdpr/resolvers/user-consent.resolver.ts:284-299` — leftmost, client-controlled XFF stored with consent records :169-219
- `apps/auth-service/src/modules/authentication/services/token.service.ts:455-479` — IP persisted on refresh-token and session rows

Invariant: A client network address recorded for security or consent evidence comes from the trusted-proxy resolver, never from a raw header the client controls.

A client can write any IP into session rows, audit entries and GDPR consent evidence by sending X-Forwarded-For, which defeats IP-based anomaly detection and taints consent records.

Fix direction: Route every IP read in auth-service through resolveClientNetworkContext and make the raw header unreachable (a lint/invariant on req.ip / x-forwarded-for outside the resolver).

## SEC-LOW-192 — VerifiedUserAssertionMiddleware skips the service-identity requirement in production for any request whose operationName is IntrospectionQuery or whose body contains '**type' (which also matches '**typename')

Rule: AUTH-R08. Evidence at `c1d183969`:

- `libs/backend-common/src/middleware/verified-user-assertion.middleware.ts:285-291` — requiresServiceIdentity skips on isIntrospectionQuery
- `libs/backend-common/src/middleware/verified-user-assertion.middleware.ts:314-331` — isIntrospectionQuery reads operationName and a \_\_type substring
- `libs/backend-common/src/guards/service-identity.guard.ts:76` — GraphQL is backstopped by the guard; the residual is REST routes behind the middleware

Invariant: A client-controlled request field never relaxes an authentication requirement in production.

The skip is decided by text the client sends. GraphQL routes are still protected by ServiceIdentityGuard, so the residual exposure is REST routes that rely on the middleware alone.

Fix direction: Decide introspection from the parsed operation (and only where introspection is enabled), not from operationName or a substring, or drop the production skip.

## SEC-LOW-193 — viewAnnouncement loads an announcement by client-supplied id with no tenant or audience check and writes an acknowledgement and a viewCount increment against it

Rule: AUTH-R12. Evidence at `c1d183969`:

- `apps/auth-service/src/modules/announcement/services/announcement.service.ts:344-390`
- `apps/auth-service/src/modules/announcement/services/announcement.service.ts:159-175` — getAnnouncement does check scope

Invariant: A tenant user's write against a cross-tenant record is scoped to the records that user may read.

A TENANT_ADMIN who knows another tenant's announcement UUID can add an acknowledgement row to it and bump its view count. Content is not returned.

Fix direction: Reuse getAnnouncement's audience/tenant check in viewAnnouncement.

## SEC-LOW-194 — TenantIsolationGuard's cross-tenant allowance compares roles against lower-case literals ('platform_admin', 'super_admin', 'partner', 'admin') that the Role enum never produces

Rule: AUTH-R18. Evidence at `c1d183969`:

- `apps/gateway-api/src/guards/tenant-isolation.guard.ts:96-259` — lower-case role literals at :96, :249 and :259
- `libs/backend-common/src/decorators/roles.decorator.ts:24` — Role.SUPER_ADMIN = 'SUPER_ADMIN'
- `apps/gateway-api/src/auth/api-key-auth.strategy.ts:91-95` — only operator-configured API_KEYS roles could match

Invariant: Authorization compares against the Role enum, never a string literal.

Fails closed for real JWTs (dead branch); an operator-configured API key role spelled 'super_admin' would get cross-tenant access the enum-based guards would not grant.

Fix direction: Compare against Role values and delete the literal branch or make it explicit with an enum member.

## HR-MEDIUM-021 — completeGoal has no role gate and CompleteGoalHandler no ownership or manager check, so any tenant user can complete any employee's performance goal

Rule: AUTH-R05. Evidence at `c1d183969`:

- `apps/hr-service/src/performance/performance.resolver.ts:526` — no @Roles; class guard GqlAuthGuard only, :83
- `apps/hr-service/src/performance/handlers/complete-goal.handler.ts:24-43`
- `libs/backend-common/src/guards/roles.guard.ts:67-72` — RolesGuard is opt-in

Invariant: A mutation of another person's HR record checks that the caller is that person, their manager or an HR role.

Goal completion feeds performance reviews; a peer can mark another employee's goals complete.

Fix direction: Gate the mutation (HR/manager roles) and enforce employee-or-manager ownership in the handler.

## SENSOR-MEDIUM-132 — saveDashboardLayout overwrites the tenant's system-default dashboard when given its id, bypassing the @Roles gate on saveSystemDefaultLayout

Rule: AUTH-R05. Evidence at `c1d183969`:

- `apps/sensor-service/src/dashboard/dashboard.service.ts:32-46` — getLayoutById lets any user load a userId-NULL system default
- `apps/sensor-service/src/dashboard/dashboard.service.ts:100-110` — the update path then writes name, description and widgets
- `apps/sensor-service/src/dashboard/dashboard.resolver.ts:69-83` — saveDashboardLayout, no role gate
- `apps/sensor-service/src/dashboard/dashboard.resolver.ts:84` — saveSystemDefaultLayout is @Roles(SUPER_ADMIN, TENANT_ADMIN

Invariant: A write to a tenant-wide record goes through the gated path; read access is not write access.

Any tenant user changes the default dashboard every user without a personal layout sees.

Fix direction: Split read from write authority in getLayoutById (a write requires ownership; system defaults only via saveSystemDefaultLayout).

## SENSOR-MEDIUM-133 — The stuck-deployment sweeper catches a per-program database error inside an open transaction, logs it and commits, so one failure aborts the transaction and silently discards every revert in that schema

Rule: DB-R07. Evidence at `c1d183969`:

- `apps/sensor-service/src/automation/automation.service.ts:2803-2851` — startTransaction :2803; per-program try with manager.save and UPDATE deployment_logs; catch :2845 logs; commitTransaction :2851

Invariant: After a statement error inside a transaction, the code rolls back (or uses a savepoint per item); it never continues and commits.

PostgreSQL marks the transaction aborted after the first error: later statements fail with 25P02 and COMMIT becomes ROLLBACK, so programs stay in DEPLOYING while the logs claim they were reverted. Same class as FARM-MEDIUM-349.

Fix direction: One savepoint per program (nested queryRunner transaction) or one transaction per program; add the DB-R07 shape to an invariant.

## MSG-MEDIUM-082 — Knowledge extraction catches a per-message error inside the tenant transaction, logs it and commits, so one failing message silently discards the extraction of every message in the batch

Rule: DB-R07. Evidence at `c1d183969`:

- `apps/messaging-service/src/ai/services/knowledge-extraction.service.ts:240-289` — startTransaction :242; per-message try :277 passes queryRunner to processMessage; catch :279-284 warns; commitTransaction :286

Invariant: After a statement error inside a transaction, the code rolls back (or uses a savepoint per item); it never continues and commits.

A database error in processMessage aborts the transaction (25P02); the loop continues, every later message fails, and the commit rolls back. The messages stay unprocessed and are retried every run.

Fix direction: Savepoint per message, or process each message in its own transaction.

## INFRA-MEDIUM-200 — The gateway WebSocket NATS bridge adds NATS_AUTH token or user/pass to the CONNECT options and replaces the shared factory's TLS options, contrary to ADR-015

Rule: INFRA-R05. Evidence at `c1d183969`:

- `apps/gateway-api/src/websocket/nats-bridge.service.ts:89-121` — factory options at :89, tls overwritten at :97-107, token/user/pass at :111-121
- `libs/backend-common/src/nats/nats-connection.factory.ts` — mtls-cert mode writes no user/pass/token

Invariant: NATS identity is the mTLS certificate CN only; only the shared factory chooses connection auth and TLS (ADR-014/015).

The server ignores CONNECT user/pass under verify_and_map, so the credentials are dead weight that still travel and must be provisioned; the TLS override drops whatever the factory set (servername, cert source) whenever NATS_TLS_ENABLED is true. The NATS invariant checks the factory, not its callers, so this was not caught.

A second copy of the same block lives in the sibling bridge — the scan found it after registration:
`apps/gateway-api/src/websocket/st-language-bridge.service.ts:100-123` (factory options, then `tls`
overwritten and `NATS_AUTH_TOKEN` / `NATS_AUTH_USER` / `NATS_AUTH_PASS` added). The fix covers both.

Fix direction: Delete the local auth/TLS block and use buildNatsConnectionOptions unchanged; extend the NATS invariant to fail on credential or tls keys set outside the factory.

## INFRA-LOW-201 — The /remotes/<module>/ nginx locations declare their own add_header lines and therefore drop the server's HSTS, X-Frame-Options, nosniff and CSP headers for every microfrontend asset

Rule: INFRA-R06. Evidence at `c1d183969`:

- `infrastructure/nginx/droplet.conf:493-557` — eight /remotes/\* blocks add Access-Control-Allow-Origin and Cache-Control only
- `infrastructure/nginx/droplet.conf:191` — server-level HSTS that those locations no longer inherit

Invariant: A location that declares add_header re-declares (or includes) the security header set; nginx does not merge inherited add_header.

SEC-MEDIUM-052 fixed the same shape for /mobile/. JavaScript served without nosniff is the practical gap.

Fix direction: Include the security-headers snippet in each /remotes/\* location (or move CORS/cache headers to a map so the locations declare none).

## Second batch — database and NATS leads (verified 2026-10-03)

The DB/infra bank's 20-flag sample at `81f39a912`: DB-R02 6 of 8 real, DB-R03 0 of 4 (an INSERT's action
value read as an UPDATE, an upsert keyed on tenantId, and helpers whose caller binds the tenant), INFRA-R06
8 letter-true but 7 in nginx files nothing deploys (`nginx/nginx.conf`, `infrastructure/docker/nginx/nginx.prod.conf`).
The live `droplet.conf` also serves `scada-viewer-canvas.html` under `/remotes/sensor-module/` (:510) without the
server's CSP or HSTS — a stronger case of INFRA-LOW-201 than `:494`, fixed by the same change.

### PLAT-HIGH-921 — The global TenantExecutionContextInterceptor never wraps @MessagePattern handlers in the four hybrid services that register it, because connectMicroservice is called without inheritAppConfig; ORPHAN-CRITICAL-574's NATS arm is dead code

Source: runtime probe. Evidence at `405f2ecac`:

- `libs/backend-common/src/bootstrap/create-service-app.ts:761-766` — connectMicroservice with no inheritAppConfig
- `libs/backend-common/src/context/tenant-execution-context.module.ts:36-40` — registered as APP_INTERCEPTOR on the HTTP application config
- `libs/backend-common/src/context/tenant-execution-context.interceptor.ts:64-93` — the rpc arm that reads tenantId from the payload
- `apps/auth-service/src/main.ts:23` — hybrid; likewise ai-service, messaging-service, sensor-service
- `docs/reviews/orphan-findings.md:8373` — ORPHAN-CRITICAL-574 marked RESOLVED on the claim that a new message handler cannot forget to bind context

Invariant: A protection claimed for a transport is proven on that transport, not on the component in isolation.

Runtime proof on the repository's NestJS 11.1.27: a hybrid app with an APP_INTERCEPTOR and a @MessagePattern handler, invoked through the microservice server's handler map, ran the interceptor 0 times without inheritAppConfig and 1 time with it (probe kept in the session scratchpad; it uses only @nestjs/core, @nestjs/microservices and an in-memory Server). The interceptor's own spec drives it directly, so it passed. Any NATS handler in auth, ai, messaging or sensor that relies on the interceptor runs with no AsyncLocalStorage tenant and an empty RLS GUC. No RLS refusal appears in the four services' logs over the last 7 days, so no live failure is shown; the protection is simply absent.

Fix direction: Register the interceptor on the microservice itself (the INestMicroservice returned by connectMicroservice, useGlobalInterceptors) rather than inheritAppConfig, which would also apply HTTP guards and the global ValidationPipe to NATS payloads; add a test that drives a @MessagePattern handler through the transport and asserts the tenant context.

### SENSOR-MEDIUM-134 — Three MQTT listener paths read per-tenant tables with no tenant context, so bundle acks are never applied, unknown-device lookups return null and LoRa device status is never updated

Source: DB-R02. Evidence at `81f39a912`:

- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1009` — release bundle ack; release-bundle.service.ts:91-93 and :140-147 use the injected repo on release_bundles; NotFound swallowed at :1047-1052
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1689` — edge-device.service.ts:528-531 findByCode on edge_devices
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1750` — edge-device.service.ts:2567-2583 findOne by devEui on lora_devices
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1538-1555` — getCachedDevice documents this failure and wraps its own call
- `libs/backend-common/src/database/schema-manager.service.ts:383` — release_bundles, edge_devices and lora_devices are per-tenant

Invariant: Code that runs outside a request establishes tenant context before it reads or writes a per-tenant table.

Outside a request the pool routes to the source schema, whose per-tenant tables are empty templates, so these lookups find nothing and the handlers log and move on. The same file fixed one sibling (getCachedDevice) and left these. The verifier also saw two likely further cases not in the sample: nats-ingestion-consumer.service.ts:207 (getSensor) and mqtt-listener.service.ts:1122 (raw SQL on deployment_logs).

Fix direction: Resolve the device's tenant first (edge_device_directory) and run each lookup inside withTenantContext, as getCachedDevice does; make the injected per-tenant repositories unreachable from MQTT/NATS entry points without a context (tier 1), not only these call sites.

### SENSOR-MEDIUM-135 — The sensor lookup responder for the Rust ingestion sidecar reads per-tenant sensors and channels from a raw NATS loop with no tenant context, so every lookup replies null

Source: DB-R02. Evidence at `81f39a912`:

- `apps/sensor-service/src/ingestion/sensor-lookup-responder.service.ts:151` — handleLookupRequest
- `apps/sensor-service/src/ingestion/sensor-lookup-responder.service.ts:296-310` — loop started from onModuleInit
- `apps/sensor-service/src/ingestion/sensor-meta-cache.service.ts:80-106` — injected repositories on sensors and sensor_data_channels
- `docker-compose.droplet.yml:1125` — sidecar defined; pilot-gated, zero tenants routed, container not running on 2026-10-03

Invariant: Code that runs outside a request establishes tenant context before it reads or writes a per-tenant table.

Latent today because no tenant routes ingestion to the sidecar; the first tenant flipped to the Rust backend would get null for every sensor lookup.

Fix direction: Carry the tenant in the lookup request (or resolve it from the device directory) and read inside withTenantContext; add a responder test that runs outside any request frame.

### MSG-MEDIUM-083 — Admin messaging monitoring aggregates messages and channels from the source schema under withBypass, while those tables are per-tenant, so the admin monitoring stats read zero or stale counts

Source: DB-R02. Evidence at `81f39a912`:

- `apps/messaging-service/src/event-handlers/messaging-admin-nats.handler.ts:119-129`
- `apps/messaging-service/src/monitoring/services/monitoring-stats.service.ts:180-219` — aggregatePerTenant reads messaging.messages and messaging.channels
- `libs/backend-common/src/database/schema-manager.service.ts:782-801` — messages and channels are per-tenant clones
- `docs/reviews/admin-expert/2026-07-12-admin-panels-enterprise.md:147-152` — arbiter ruling assumed the per-tenant copies were vestigial

Invariant: A cross-tenant aggregate reads each tenant's schema (or a maintained projection), never the source template of a per-tenant table.

Writes go to tenant\_<hex> (message.resolver.ts:272, tenant-transaction.ts:106-122) and the source copies are write-guarded (ORPHAN-HIGH-415), so the aggregate reads empty templates. The arbiter ruling it rests on predates the current routing and needs reopening.

Fix direction: Aggregate per tenant schema (forEachTenantSchema with a bounded query) or from a projection the write path maintains; reopen the 2026-07-12 ruling.

## Third batch — fresh-sample pass over the revised auth bank (2026-10-03)

A fresh 44-flag sample of the revised auth bank (v2.1) at `405f2ecac`, none judged before: 9 real, 3 minor, 32 false
(27%). The revision that cut false flags on the tuning sample did not raise precision on fresh flags, so only the
rules with measured yield stay active (R05 missing gate, R06 role/permission writes, R16 client IP, R09 token mint);
the rest are off until redesigned. New defects from this pass:

### RBAC-HIGH-019 — createTenantUser assigns input.roleId after only an existence check, so a delegate holding users:invite can create an account, with a password it chooses, at a role above its own level

Evidence at `405f2ecac`:

- `apps/auth-service/src/modules/tenant/resolvers/tenant-role.resolver.ts:280-281` — @RequireTenantPermission('users:invite'
- `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:221-224` — getRoleById existence check only
- `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:230-233` — overrides are authority-checked; the role is not
- `apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:252` — password taken from the input
- `apps/auth-service/src/modules/tenant/services/tenant-user-management.service.ts:460-488` — assertRoleGrantAuthority, which assignUserRole calls and createUser does not

Invariant: Every path that gives a user a role passes the actor's grant ceiling, including account creation.

With RBAC-HIGH-017 (role level unbounded on update) and the createRole sibling below, a non-admin delegate has a complete in-tenant escalation chain: raise a role's level, then mint an account holding it.

Fix direction: Route createUser's role through assertRoleGrantAuthority (the same branded grant the assign path uses), so a role id can only reach a user row through the ceiling check (tier 1).

### SEC-MEDIUM-195 — A TENANT_ADMIN can cancel any PLATFORM announcement, and delete a draft one, because cancelAnnouncement and deleteAnnouncement reuse the read check and never re-check scope as publishAnnouncement does

Evidence at `405f2ecac`:

- `apps/auth-service/src/modules/announcement/services/announcement.service.ts:306-335` — cancelAnnouncement and deleteAnnouncement
- `apps/auth-service/src/modules/announcement/services/announcement.service.ts:159-175` — getAnnouncement lets a TENANT_ADMIN read PLATFORM rows
- `apps/auth-service/src/modules/announcement/services/announcement.service.ts:278-286` — publishAnnouncement re-checks scope: PLATFORM requires SUPER_ADMIN
- `apps/auth-service/src/modules/announcement/resolvers/announcement.resolver.ts:119-135` — @TenantAdminOrHigher on both mutations

Invariant: Read access is not write access: a mutation of a platform-scoped record requires the platform role.

One tenant's admin can withdraw an announcement every tenant sees.

Fix direction: Extract the scope-for-write check publishAnnouncement uses into one method and call it from every mutating path (cancel, delete, update).

### Scope added to earlier findings

- RBAC-HIGH-017 also covers `createRole`: `tenant-role.service.ts:518-530` inserts `input.level` (1..100) with no
  ceiling while its capabilities are validated (:475-483). The fix bounds `level` on both create and update.
- HR-MEDIUM-021 covers the whole goal/review mutation surface of `performance.resolver.ts`, not only `completeGoal`:
  `submitSelfAssessment` (:365), `acknowledgeReview` (:429), `cancelGoal` (:539) and `addMilestone` (:593) have no
  gate, and their handlers (`submit-self-assessment.handler.ts:24-41`, `acknowledge-review.handler.ts:24-47`,
  `cancel-goal.handler.ts:24-46`, `add-milestone.handler.ts:25-47`) load by id and tenant with no ownership or manager
  check. Fix at the resolver (class-level gate plus per-mutation ownership), not mutation by mutation.
