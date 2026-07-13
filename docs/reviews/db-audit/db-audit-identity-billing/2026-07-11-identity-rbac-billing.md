# DB Audit — Identity, Tenant RBAC & Billing Partition — 2026-07-11

**Agent:** db-audit-identity-billing (Lane-D) · **Mode:** CATCHER · **Cycle:** 2026-07-11
**Prefix:** `DB-IDENT-{SEVERITY}-{NNN}`

## Scope

Provenance / read-exposure / frontend-reachability audit of every durable column in:
- `apps/auth-service` (`auth` schema — 20 `@Entity` classes + the raw-SQL tenant-RBAC tables `auth.tenant_roles`, `auth.tenant_role_permissions`, `auth.user_role_assignments`, which have NO `@Entity` class and are reached via `DataSource.query`).
- `apps/billing-service` (`billing` schema — 12 `@Entity` classes across 10 files; `usage-aggregation.entity.ts` packs 2).
- The `shared` schema's 5 canonical tables (`audit_logs`, `gdpr_data_requests`, `user_consents`, `user_permissions`, `access_logs`) — each must have live cross-service writers AND readers.
- The shared `@Entity` classes under `libs/**` (actual count: 6 in `libs/backend-common` — `shared.audit_logs`, `shared.access_logs`, `shared.user_consents`, `shared.gdpr_data_requests`, `compliance.legal_holds`, `event_store.findings`; the two outbox base classes in `platform/libs/outbox` are abstract bases, not tables — the partition's "~25" estimate does not match the tree).
- Frontend reachability via `web/modules/tenant-admin` + shell/login.

Secret-column exposure was traced explicitly for every credential-bearing column. Every incidental defect noticed while tracing is in Appendix B (operator directive 2026-07-11).

## Executive summary

Two shared-schema canonical tables fail the "live cross-service writer AND reader" invariant:

1. `DB-IDENT-HIGH-001` — `shared.user_permissions` is a **parallel/duplicate RBAC catalogue**. Its `PanelPermissions` taxonomy is disjoint from the LIVE store (`auth.tenant_role_permissions.resource_permissions`) that token issuance and `TenantPermissionGuard` actually read. Only `admin-api-service` writes/reads it (REST, non-federated). The bootstrap SSoT calls it "RBAC permissions, read by every service" — false. Violates the "RBAC catalogue single-sourced" invariant.

2. `DB-IDENT-HIGH-002` — `shared.access_logs` is a **dead compliance surface**: its entity, `AccessLogService`, and `AccessLogMiddleware` all live in `libs/backend-common`, but NO service wires `AccessLogModule.forRoot()` or mounts the middleware. No writer, no reader. The invariant test the code claims enforces mounting (`access-log-middleware-mounted.spec.ts`) does not exist.

Secret columns (`User.password/mfaSecret/mfaRecoveryCodes/lastUsedTotpStep/passwordResetToken/invitationToken`, `RefreshToken.token`, `ActionToken.tokenHash`, `WebAuthnCredential.publicKey`, all `stripe*` ids) are correctly `@HideField`/no-`@ObjectType` on GraphQL, and admin-api REST uses explicit column-lists that exclude them (session token masked `LEFT(token,20)||'...'`). No secret-exposure CRITICAL found. The Stripe webhook path is robust (HMAC-SHA256 + `timingSafeEqual` + skew check + persistent DB dedup + Redis dedup + audit rows, fail-closed). D14 tenant/subscription placement is honoured (`auth.tenants` authoritative, `billing.subscriptions` keyed by tenantId).

## Findings (by severity)

### CRITICAL
_None. All secret-bearing columns are BE-only with no API/log exposure found._

### HIGH

#### DB-IDENT-HIGH-001 — `shared.user_permissions` is a parallel/dead RBAC catalogue with a false SSoT claim
**Severity:** HIGH · **Layer:** 2 (RBAC single-source / tenant isolation) · **State:** OPEN

**Evidence**
- `apps/db-migrate/src/sql/platform-bootstrap/006-shared-schema-tables.sql:9` — "`shared.user_permissions` — RBAC permissions, read by every service"; `:37-39` — "every tenant-scoped query path consults it".
- `apps/admin-api-service/src/users/entities/user-permissions.entity.ts:97-125` — `@Entity('user_permissions',{schema:'shared'})`, `permissions: jsonb PanelPermissions` (dashboard/farms/batches/feeding/sensors/maintenance/hr/reports/settings/users).
- `apps/admin-api-service/src/users/services/user-permissions.service.ts` — sole writer/reader.
- `apps/admin-api-service/src/users/users.controller.ts:585-660` — `GET/PUT /users/:id/permissions` (`AllowTenantAdmin`). admin-api is NOT a federated subgraph.
- LIVE store read by token mint: `apps/auth-service/src/modules/authentication/services/token.service.ts:583-594` selects `auth.tenant_role_permissions.resource_permissions`. `PanelPermissions` never read there.
- Live RBAC UI: `web/modules/tenant-admin/src/graphql/index.ts:24-33` reads `TENANT_ROLES_QUERY`/`PERMISSION_CATEGORIES_QUERY` (auth catalogue) — not `PanelPermissions`.
- Grep `user_permissions`/`UserPermissions` across `apps/**`: only `admin-api-service` + `db-migrate` bootstrap — no cross-service reader.

**Rule violated**
Domain invariant "RBAC catalogue is single-sourced"; layer-2 duplicate-structure. Shared-schema allowlist requires each canonical table to have real cross-service writers AND readers.

**Proposed fix direction**
- Pick a single owner: retire `shared.user_permissions` and fold per-user checkbox overrides into `auth.user_role_assignments.permission_overrides` (already honoured by the guard), OR make admin-panel checkboxes write the auth catalogue read path.
- Correct/remove the false "read by every service" comment and the PUBLIC DML grant premised on it; changing the canonical 5-table set requires an ADR + arbiter approval.

**Affected surface (ripple set)**
`apps/admin-api-service/src/users/**` · `apps/db-migrate/src/sql/platform-bootstrap/006-shared-schema-tables.sql` · `libs/backend-common/src/constants/protected-tables.ts` · `scripts/schema-registry/generate-init-schemas.ts` · `tests/invariants/shared-schema-canonical.spec.ts` · web/modules/admin-panel permission-checkbox UI.

**Expected closer** `auth-security-expert`/`data-expert` WRITER + ADR.

#### DB-IDENT-HIGH-002 — `shared.access_logs` is an unwired dead compliance surface (no writer, no reader)
**Severity:** HIGH · **Layer:** 2 (shared-schema allowlist: canonical table must have a live writer) · **State:** OPEN

**Evidence**
- Entity/service/middleware present: `libs/backend-common/src/audit/access-log.entity.ts`, `access-log.service.ts`, `access-log.module.ts` (`@Global` `forRoot()`), `libs/backend-common/src/middleware/access-log.middleware.ts`.
- `access-log.module.ts:20-26` — comment says services must `consumer.apply(AccessLogMiddleware).forRoutes('*')` and that `tests/invariants/access-log-middleware-mounted.spec.ts` enforces it.
- Grep `AccessLogModule|AccessLogMiddleware|AccessLogService` across `apps/**`: **zero matches** — no service imports the module or mounts the middleware.
- The claimed enforcement test does not exist (Glob `tests/invariants/access-log-middleware-mounted.spec.ts` → none; only `access-log-stream-shape.spec.ts` exists, which checks entity shape, not mounting).
- Grep `access_logs` across `apps/**`: only `db-migrate` bootstrap (creates the table) + an archived migration — no reader (admin-api never queries it).

**Rule violated**
Domain invariant "Shared-schema allowlist is closed" — "a canonical table with no live writer is itself a HIGH finding (dead compliance surface)." The platform believes it has request-level (non-mutation read) forensics; it does not.

**Proposed fix direction**
- Wire `AccessLogModule.forRoot()` + mount `AccessLogMiddleware` in each in-scope service's `AppModule.configure()` AND land the real mounting invariant test; OR
- If low-level access logging is deliberately deferred, remove `shared.access_logs` from the canonical 5-table set via ADR (do not keep a phantom compliance table).

**Affected surface (ripple set)**
Every service `AppModule` · `libs/backend-common/src/audit/access-log.module.ts` · `tests/invariants/` (new mounting spec) · `006-shared-schema-tables.sql` + `protected-tables.ts` + `SHARED_SCHEMA_TABLES` if removed.

**Expected closer** `observability-expert`/`platform-kernel-expert` WRITER (wire it) or `data-expert` + ADR (remove it).

### MEDIUM

#### DB-IDENT-MEDIUM-001 — Two overlapping admin↔tenant support-conversation surfaces in `auth`
**Severity:** MEDIUM · **Layer:** 2 (duplicate structure) · **State:** OPEN
**Evidence** `auth.message_threads`/`auth.messages` (`SupportMessageThread`/`SupportMessage`, `modules/messaging/entities/*`) AND `auth.support_tickets`/`auth.ticket_comments` (`modules/support/entities/*`) both model SuperAdmin↔TenantAdmin conversations, both FE-reachable via `web/modules/tenant-admin` `communication-queries` (`MY_THREADS_QUERY` + `MY_TICKETS_QUERY`). No declared single owner of "admin-to-tenant conversation."
**Rule** layer-2 duplication. **Fix** Declare the boundary (ticket = SLA-tracked formal issue; thread = free chat) in a doc, or consolidate; ensure `commentCount`/`messageCount` denormals stay reconciled. **Closer** admin-expert.

#### DB-IDENT-MEDIUM-002 — Two overlapping usage-metering models in `billing`
**Severity:** MEDIUM · **Layer:** 2 (duplicate structure) · **State:** OPEN
**Evidence** `billing.tenant_usage_metrics` (`billing/entities/tenant-usage-metrics.entity.ts`, `ModuleUsageMetrics` jsonb) AND `billing.usage_aggregations`+`billing.usage_hourly_data` (`modules/metering/entities/usage-aggregation.entity.ts`) both persist per-tenant metered usage with disjoint shapes. admin-api reads both via separate readonly projection entities (`usage-aggregation-readonly.entity.ts`, `tenant-usage-metrics-readonly.entity.ts`). No single SSoT for "tenant usage."
**Rule** layer-2 duplication. **Fix** Declare which is authoritative for billing vs. analytics; reconcile or converge. **Closer** billing-expert.

#### DB-IDENT-MEDIUM-003 — `auth.modules.price`/`isCore` duplicates billing pricing (cross-service pricing fork)
**Severity:** MEDIUM · **Layer:** 2 (D14 subscription SSoT / duplication) · **State:** OPEN
**Evidence** `apps/auth-service/src/modules/system-module/entities/module.entity.ts:110-121` — `price decimal` + `isCore`, comment: "Billing resolver sums module prices to compute total plan cost." Billing independently owns `billing.plans.basePrice` + `billing.subscription_module_items` pricing. Two pricing sources; D14 names billing the subscription SSoT.
**Rule** D14 / layer-2 duplication. **Fix** Make billing the sole price authority; auth.modules should carry catalogue metadata only, or read price from billing. **Closer** billing-expert + auth-security-expert.

#### DB-IDENT-MEDIUM-004 — `auth.user_module_assignments.permissions` (jsonb) is a per-user permission map with no authorization reader (SUSPECT→likely write-only)
**Severity:** MEDIUM · **Layer:** 2 (dead/parallel permission field) · **State:** OPEN
**Evidence** `user-module-assignment.entity.ts:81-83` — `permissions?: Record<string,boolean>` + `hasPermission()` helper. Token mint (`token.service.ts:436-448 getUserModules`) reads assignments but maps only `code/name/defaultRoute` — never `permissions`. Guards resolve authz from `auth.tenant_role_permissions`. Searched: `token.service.ts`, `tenant-role.service.ts`, resolvers — no read of `UserModuleAssignment.permissions` for an access decision. Class SUSPECT (write path exists via assignment; no authz read found).
**Rule** layer-2 duplicate/dead permission surface. **Fix** Confirm dead → drop the column, or wire it into the resolved permission set. **Closer** auth-security-expert.

### LOW

#### DB-IDENT-LOW-001 — `compliance.legal_holds` registry appears unwritten (future surface still inert)
**Severity:** LOW · **Layer:** 2 · **State:** OPEN
**Evidence** `libs/backend-common/src/compliance/legal-hold/legal-hold.entity.ts` (`@Entity('legal_holds',{schema:'compliance'})`); `protected-tables.ts:20-25` calls it "the FUTURE `compliance.legal_holds`." Per-tenant legal holds live in `messaging.legal_holds`; the cross-tenant `compliance.legal_holds` writer was not located in this pass. Out of core partition (compliance schema) — recorded for completeness.

#### DB-IDENT-LOW-002 — Monetary GraphQL fields serialized as `Float` (billing)
**Severity:** LOW · **Layer:** 1 · **State:** OPEN (already tracked upstream as PLAT-LOW-001/002)
**Evidence** `invoice.entity.ts` (`subtotal/total/amountDue`), `plan.entity.ts:49-51 basePrice`, `payment.entity.ts amount` — DB is lossless `numeric(19,4)` via `MoneyColumn`/`DecimalTransformer`, but `@Field(() => Float)` serializes lossily on the wire. Pre-existing, noted per operator directive.

## Cross-domain dependencies flagged
- DB-IDENT-HIGH-001 → `auth-security-expert` (RBAC SSoT) + `admin-expert` (admin-panel write UI) + `architectural-arbiter` (shared-table set change needs ADR).
- DB-IDENT-HIGH-002 → `observability-expert`/`platform-kernel-expert` (wire) or `data-expert` + arbiter (remove).
- DB-IDENT-MEDIUM-002/003/LOW-002 → `billing-expert`.

## Verdict
CONDITIONAL — no CRITICAL; two HIGH (both shared-schema canonical tables failing the live-writer/reader invariant) block a clean pass until owned. Secret exposure and money-path reconciliation are sound.

## References
- Methodology: `.claude/agents/_shared/db-audit-methodology.md`
- Knowledge: layer-1-{core,nestjs,typeorm,react}, layer-2-{patterns,defect-catalog}, layer-3-adrs
- SSoT: `tests/invariants/shared-schema-canonical.spec.ts`, `libs/backend-common/src/constants/protected-tables.ts`, `apps/db-migrate/src/sql/platform-bootstrap/006-shared-schema-tables.sql`
- Prior: MEMORY tenant_rbac_ssot / tenant_configurable_rbac; `docs/reviews/tenant-rbac/2026-07-07-tenant-rbac-bridge.md`; `docs/reviews/orphan-findings.md`

---

# Appendix A — Provenance matrix

`| column | writer | read | fe | class |`. Deep evidence for non-OK rows lives in Findings above.

## auth-service (`auth` schema)

### auth.users  (`user.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id | SYSTEM | GRAPHQL | tenant-admin/users | OK |
| email | FE-FORM | GRAPHQL | tenant-admin/users, login | OK |
| password | FE-FORM | NONE (@HideField, peppered bcrypt) | NONE | BE-ONLY (secret) |
| firstName/lastName | FE-FORM | GRAPHQL | tenant-admin/users | OK |
| role | FE-FORM/SYSTEM | GRAPHQL + token | tenant-admin/users | OK |
| tenantId | SYSTEM | GRAPHQL + token | tenant-admin | OK |
| accessType | FE-FORM | GRAPHQL | tenant-admin | OK |
| isActive | FE-FORM/SYSTEM | GRAPHQL | tenant-admin | OK |
| isEmailVerified | SYSTEM | GRAPHQL | tenant-admin | OK |
| invitationToken | SYSTEM | NONE (@HideField) | NONE | BE-ONLY (secret) |
| invitationExpiresAt | SYSTEM | NONE (@HideField) | NONE | BE-ONLY |
| invitedBy | SYSTEM | NONE (@HideField) | NONE | BE-ONLY |
| profileImageUrl | FE-FORM | GRAPHQL | tenant-admin | OK |
| phoneNumber | FE-FORM | NONE (@HideField, PII) | NONE | BE-ONLY |
| preferredLanguage | FE-FORM | GRAPHQL | tenant-admin | OK |
| notificationPreferences | FE-FORM | GRAPHQL (own prefs query) select:false col | tenant-admin/settings | OK |
| mfaEnabled | SYSTEM | GRAPHQL | tenant-admin | OK |
| mfaSecret | SYSTEM (AES-256-GCM) | NONE (@HideField) | NONE | BE-ONLY (secret) |
| mfaRecoveryCodes | SYSTEM (SHA-256) | NONE (@HideField) | NONE | BE-ONLY (secret) |
| mfaFailedAttempts | SYSTEM | NONE | NONE | BE-ONLY |
| mfaLockedUntil | SYSTEM | NONE | NONE | BE-ONLY |
| lastUsedTotpStep | SYSTEM | NONE (@HideField) | NONE | BE-ONLY (secret) |
| lastLoginAt | SYSTEM | GRAPHQL | tenant-admin | OK |
| lastLoginIp | SYSTEM | NONE (@HideField, PII) | NONE | BE-ONLY |
| passwordResetToken | SYSTEM | NONE (@HideField) | NONE | BE-ONLY (secret) |
| passwordResetExpires | SYSTEM | NONE (@HideField) | NONE | BE-ONLY |
| failedLoginAttempts | SYSTEM | NONE | NONE | BE-ONLY |
| lockedUntil | SYSTEM | GRAPHQL | tenant-admin/users | OK |
| createdAt/updatedAt | SYSTEM | GRAPHQL | tenant-admin | OK |

### auth.refresh_tokens  (`refresh-token.entity.ts`) — no `@ObjectType`
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id | SYSTEM | BE-INTERNAL | NONE | OK |
| token | SYSTEM (bcrypt-hashed) | BE-INTERNAL (lookup); admin-api masks | NONE | BE-ONLY (secret) |
| userId | SYSTEM | BE-INTERNAL | NONE | OK |
| familyId | SYSTEM | BE-INTERNAL | NONE | OK |
| rememberMe | FE-FORM (login) | BE-INTERNAL (cookie maxAge) | NONE | OK |
| tenantId | SYSTEM | BE-INTERNAL | NONE | OK |
| expiresAt/isRevoked/revokedAt/revokedReason | SYSTEM | BE-INTERNAL | NONE | OK |
| userAgent/ipAddress/deviceId | SYSTEM | BE-INTERNAL (admin session list) | admin-panel | OK |
| createdAt | SYSTEM | BE-INTERNAL | NONE | OK |

### auth.action_tokens  (`action-token.entity.ts`) — no `@ObjectType`
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/purpose/tenantId/userId | SYSTEM | BE-INTERNAL | NONE | OK |
| tokenHash | SYSTEM (hash) | BE-INTERNAL (lookup) | NONE | BE-ONLY (secret) |
| deliveryIdempotencyKey | SYSTEM | BE-INTERNAL | NONE | OK |
| status/expiresAt/consumedAt/revokedAt/auditMetadata | SYSTEM | BE-INTERNAL | NONE | OK |
| createdAt/updatedAt | SYSTEM | BE-INTERNAL | NONE | OK |

### auth.webauthn_credentials  (`webauthn-credential.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/credentialId/transports/deviceName | SYSTEM/FE-FORM | GRAPHQL | settings | OK |
| userId | SYSTEM | NONE (@HideField) | NONE | BE-ONLY |
| publicKey | SYSTEM | NONE (@HideField) | NONE | BE-ONLY (key material) |
| counter | SYSTEM | NONE (@HideField) | NONE | BE-ONLY |
| createdAt/updatedAt/lastUsedAt | SYSTEM | GRAPHQL | settings | OK |

### auth.tenants  (`tenant.entity.ts`) — D14 authoritative tenant row
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id | SYSTEM | GRAPHQL + token(planLevel lookup) | tenant-admin, admin-panel | OK |
| name/slug/description/logoUrl | FE-FORM | GRAPHQL | tenant-admin | OK |
| contactEmail/contactPhone/address/taxId | FE-FORM | GRAPHQL | tenant-admin | OK |
| status | SYSTEM (lifecycle) | GRAPHQL | admin-panel | OK |
| plan | SYSTEM/EVENT (billing projection) | GRAPHQL + token | admin-panel | OK |
| maxUsers/maxStorage/userCount | FE-FORM/SYSTEM | GRAPHQL | admin-panel | OK |
| trialEndsAt/subscriptionEndsAt | SYSTEM | GRAPHQL | admin-panel | OK |
| customDomain | FE-FORM | GRAPHQL | admin-panel | OK |
| settings | FE-FORM | GRAPHQL | tenant-admin/settings | OK |
| createdBy | SYSTEM | GRAPHQL | admin-panel | OK |
| createdAt/updatedAt/version | SYSTEM | GRAPHQL | admin-panel | OK |
| isTrialActive (getter, no column) | — | GRAPHQL | admin-panel | OK |

### auth.tenant_roles / tenant_role_permissions / user_role_assignments (raw SQL, no `@Entity`) — SINGLE-SOURCE RBAC store
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| tenant_roles.{id,tenantId,name,description,color,icon,level,is_system,is_default,created_by,created_at,updated_at} | FE-FORM (TenantRoleService) | GRAPHQL + token mint | tenant-admin/roles | OK |
| tenant_role_permissions.{id,role_id,panel_permissions,resource_permissions,created_at,updated_at} | FE-FORM | GRAPHQL + token mint (resource_permissions) | tenant-admin/roles | OK |
| user_role_assignments.{id,user_id,role_id,is_active,permission_overrides,assigned_by,assigned_at,created_at,updated_at} | FE-FORM | GRAPHQL + token mint | tenant-admin/users | OK |

### auth.user_module_assignments  (`user-module-assignment.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/userId/moduleId/tenantId/isPrimaryManager/isActive/assignedBy/expiresAt/notes | FE-FORM | GRAPHQL + token(getUserModules) | tenant-admin/modules | OK |
| permissions (jsonb) | FE-FORM | NONE for authz (see MEDIUM-004) | NONE | SUSPECT |
| createdAt/updatedAt | SYSTEM | GRAPHQL | tenant-admin | OK |

### auth.user_site_assignments  (`user-site-assignment.entity.ts`) — SEC-HIGH-051 site authz
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/userId/siteId/tenantId/isActive/assignedBy/expiresAt | FE-FORM | GRAPHQL + token(assignedSiteIds) | tenant-admin/users | OK |
| createdAt/updatedAt | SYSTEM | GRAPHQL | tenant-admin | OK |

### auth.modules  (`module.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/code/name/description/icon/color/isActive/sortOrder/defaultRoute/features | MIGRATION/SYSTEM (seed) | GRAPHQL + token | tenant-admin, admin-panel | OK |
| price | SYSTEM | GRAPHQL + billing cross-read | admin-panel | see MEDIUM-003 |
| isCore | SYSTEM | GRAPHQL | admin-panel | see MEDIUM-003 |
| createdAt/updatedAt | SYSTEM | GRAPHQL | admin-panel | OK |

### auth.tenant_modules  (`tenant-module.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/tenantId/moduleId/isEnabled/configuration/maxModuleUsers/activatedAt/expiresAt/notes/assignedBy/managerId | FE-FORM (SUPER_ADMIN) | GRAPHQL + token(getUserModules for TENANT_ADMIN) | admin-panel, tenant-admin | OK |
| createdAt/updatedAt | SYSTEM | GRAPHQL | admin-panel | OK |

### auth.mobile_user_settings  (`mobile-user-settings.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/userId/tenantId | SYSTEM | GRAPHQL + token(mobileFeatures) | tenant-admin | OK |
| allowedFeatures (jsonb) | FE-FORM | GRAPHQL + token | tenant-admin, AQUAMOBIL | OK |
| isMobileEnabled | FE-FORM | GRAPHQL + token | tenant-admin | OK |
| createdAt/updatedAt | SYSTEM | GRAPHQL | tenant-admin | OK |

### auth.invitations  (`invitation.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id | SYSTEM | GRAPHQL | admin-panel/tenant-admin | OK |
| token | SYSTEM (crypto.randomBytes) | GRAPHQL (accept flow) | invite-accept | OK (single-use accept token, unique-indexed) |
| email/firstName/lastName/role/tenantId/moduleIds/primaryModuleId | FE-FORM | GRAPHQL | tenant-admin | OK |
| status/expiresAt/acceptedAt/userId/message/invitedBy/sendCount/lastSentAt/acceptedFromIp | SYSTEM | GRAPHQL | tenant-admin | OK |
| createdAt/updatedAt | SYSTEM | GRAPHQL | tenant-admin | OK |

### auth.audit_logs  (`audit/audit-log.entity.ts`) — auth's own audit ledger (distinct from shared.audit_logs)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/performedBy/performedByEmail/action/entityType/entityId/tenantId/details/previousValue/newValue/severity/requestId/sessionId/ipAddress/userAgent/createdAt/legalHold | SYSTEM (AuditLog service) | GRAPHQL (TENANT_AUDIT_LOGS_QUERY) + admin-api (getUserActivity) | tenant-admin/audit, admin-panel | OK |

### auth.messages / auth.message_threads  (`messaging/entities/*`) — SuperAdmin↔Tenant support chat
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| message_threads.{id,tenantId,subject,lastMessage,lastMessageAt,lastMessageBy,status,messageCount,unreadCountAdmin,unreadCountTenant,createdBy,createdByAdmin,createdAt,updatedAt} | FE-FORM | GRAPHQL | tenant-admin/messages | OK (overlap → MEDIUM-001) |
| messages.{id,threadId,senderId,senderType,senderName,content,status,isInternal,attachments,readAt,createdAt} | FE-FORM | GRAPHQL (isInternal admin-only) | tenant-admin/messages | OK (overlap → MEDIUM-001) |

### auth.support_tickets / auth.ticket_comments  (`support/entities/*`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| support_tickets.{id,ticketNumber,tenantId,subject,description,category,priority,status,assignedTo,assignedToName,reportedBy,reportedByName,commentCount,slaResponseDeadline,slaResolutionDeadline,firstResponseAt,resolvedAt,satisfactionRating,satisfactionComment,tags,createdAt,updatedAt} | FE-FORM | GRAPHQL | tenant-admin/support | OK (overlap → MEDIUM-001) |
| ticket_comments.{id,ticketId,authorId,authorName,authorType,content,isInternal,attachments,createdAt} | FE-FORM | GRAPHQL (isInternal admin-only) | tenant-admin/support | OK |

### auth.announcements / auth.announcement_acknowledgments  (`announcement/entities/*`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| announcements.{id,title,content,type,status,scope,tenantId,isGlobal,targetCriteria,publishAt,expiresAt,requiresAcknowledgment,viewCount,acknowledgmentCount,createdBy,createdByName,createdAt,updatedAt} | FE-FORM | GRAPHQL | tenant-admin/announcements, admin-panel | OK |
| announcement_acknowledgments.{id,announcementId,userId,userName,tenantId,tenantName,viewedAt,acknowledgedAt} | FE-FORM/SYSTEM | GRAPHQL | tenant-admin | OK |

### auth.auth_outbox  (`outbox/auth-outbox.entity.ts`, extends OutboxEntityBase) — cross-tenant infra
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id + inherited {eventType,tenantId,aggregateId,payload,publishedAt,retryCount,lastError,nextAttemptAt,idempotencyKey,isDeadLettered,leasedAt,leasedBy,createdAt} | SYSTEM (outbox insert) | BE-INTERNAL (OutboxWorker→NATS) | NONE | OK (protected `*_outbox`) |

## billing-service (`billing` schema)

### billing.subscriptions  (`subscription.entity.ts`) — D14 subscription SSoT, keyed by tenantId
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/tenantId/planId/planTier/planName/status/billingCycle | SYSTEM/FE-FORM | GRAPHQL + auth projection | tenant-admin/billing, admin-panel | OK |
| limits/pricing (jsonb) | SYSTEM | GRAPHQL | tenant-admin/billing | OK |
| startDate/endDate/currentPeriodStart/currentPeriodEnd/trialEndDate/cancelledAt/cancellationReason/autoRenew | SYSTEM | GRAPHQL | tenant-admin/billing | OK |
| stripeSubscriptionId | EXTERNAL (Stripe) | NONE (@HideField) | NONE | BE-ONLY (secret-adjacent) |
| stripeCustomerId | EXTERNAL (Stripe) | NONE (@HideField) | NONE | BE-ONLY (secret-adjacent) |
| createdAt/updatedAt/createdBy/updatedBy/version | SYSTEM | GRAPHQL | admin-panel | OK |
| isDeleted/deletedAt/deletedBy | SYSTEM (soft-delete) | BE-INTERNAL | NONE | OK |

### billing.invoices  (`invoice.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/tenantId/invoiceNumber/subscriptionId/status | SYSTEM | GRAPHQL | tenant-admin/billing | OK |
| billingAddress/lineItems/tax (jsonb) | SYSTEM | GRAPHQL | tenant-admin/billing | OK |
| subtotal/discount/total/amountPaid/amountDue | SYSTEM (MoneyColumn) | GRAPHQL (Float→LOW-002) | tenant-admin/billing | OK |
| discountCode/currency/issueDate/dueDate/paidAt/periodStart/periodEnd/notes | SYSTEM | GRAPHQL | tenant-admin/billing | OK |
| stripeInvoiceId | EXTERNAL (Stripe) | NONE (@HideField) | NONE | BE-ONLY |
| pdfUrl | SYSTEM (allowlist-validated) | GRAPHQL | tenant-admin/billing | OK |
| createdAt/updatedAt/createdBy/updatedBy/version/isDeleted/deletedAt/deletedBy | SYSTEM | GRAPHQL/BE-INTERNAL | admin-panel | OK |

### billing.payments  (`payment.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/tenantId/transactionId/invoiceId | SYSTEM/EXTERNAL | GRAPHQL | tenant-admin/billing | OK |
| amount/currency/status/paymentMethod | EXTERNAL(webhook)/SYSTEM | GRAPHQL | tenant-admin/billing | OK |
| paymentMethodDetails (jsonb; cardExpMonth/Year @HideField) | EXTERNAL | GRAPHQL (last4 only) | tenant-admin/billing | OK |
| paymentDate/processedAt/failureReason/refunds/refundedAmount/notes | EXTERNAL/SYSTEM | GRAPHQL | tenant-admin/billing | OK |
| stripePaymentIntentId | EXTERNAL (Stripe) | NONE (@HideField, unique idx) | NONE | BE-ONLY |
| stripeChargeId | EXTERNAL (Stripe) | NONE (@HideField) | NONE | BE-ONLY |
| createdAt/updatedAt/createdBy/updatedBy/version/isDeleted/deletedAt/deletedBy | SYSTEM | GRAPHQL/BE-INTERNAL | admin-panel | OK |

### billing.stripe_webhook_events  (`stripe-webhook-event.entity.ts`) — idempotency ledger
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| eventId (PK evt_*) | EXTERNAL (Stripe, INSERT-on-receive) | BE-INTERNAL (dedup) | NONE | OK |
| eventType/receivedAt/processedAt/outcome | EXTERNAL/SYSTEM | BE-INTERNAL (triage) | NONE | OK |

### billing.plans  (`plan.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/name/tier/basePrice/currency/billingCycle/limits/pricing/features/isActive/isPublic/sortOrder | FE-FORM (admin)/SYSTEM | GRAPHQL | admin-panel, public pricing | OK |
| stripeProductId | SYSTEM/EXTERNAL | NONE (no @Field) | NONE | BE-ONLY |
| stripePriceIds (jsonb) | SYSTEM/EXTERNAL | NONE (no @Field) | NONE | BE-ONLY |
| createdAt/updatedAt/createdBy/updatedBy/version/isDeleted/deletedAt/deletedBy | SYSTEM | GRAPHQL/BE-INTERNAL | admin-panel | OK |

### billing.subscription_module_items  (`subscription-module-item.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/subscriptionId/moduleId/moduleCode/moduleName/quantities/lineItems/subtotal/discountAmount/total/currency/status/activatedAt/cancelledAt | SYSTEM | GRAPHQL | tenant-admin/billing | OK |
| configuration/notes | SYSTEM | NONE (no @Field) | NONE | BE-ONLY |
| createdAt/updatedAt | SYSTEM | GRAPHQL | tenant-admin | OK |

### billing.scheduled_plan_changes  (`scheduled-plan-change.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/tenantId/subscriptionId/currentPlanId/currentPlanTier/newPlanId/newPlanTier/newPlanName/newLimits/newPricing/status/effectiveDate/reason/scheduledBy/appliedAt/cancelledAt/cancellationReason | FE-FORM/SYSTEM (cron applies) | GRAPHQL | tenant-admin/billing | OK |
| createdAt/updatedAt | SYSTEM | GRAPHQL | tenant-admin | OK |

### billing.tenant_usage_metrics  (`tenant-usage-metrics.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/tenantId/moduleId/moduleCode/periodType/periodStart/periodEnd/metrics/calculatedCost/isFinalized/finalizedAt | SYSTEM (metering) | GRAPHQL + admin-api readonly | admin-panel | OK (overlap → MEDIUM-002) |
| includedQuantities/overageQuantities/invoiceId | SYSTEM | NONE (no @Field) | NONE | BE-ONLY |
| createdAt/updatedAt | SYSTEM | GRAPHQL | admin-panel | OK |

### billing.usage_aggregations / billing.usage_hourly_data  (`modules/metering/entities/usage-aggregation.entity.ts`)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| usage_aggregations.{id,tenantId,period,periodStart,periodEnd,meterType,dimension,dimensionValue,totalUsage,peakUsage,averageUsage,minUsage,maxUsage,eventCount,unit,metadata,createdAt,updatedAt} | SYSTEM (aggregator) | BE-INTERNAL + admin-api readonly | admin-panel | OK (overlap → MEDIUM-002) |
| usage_hourly_data.{id,tenantId,meterType,values,updatedAt} | SYSTEM | BE-INTERNAL | NONE | OK (overlap → MEDIUM-002) |

### billing.billing_outbox  (`outbox/billing-outbox.entity.ts`) — cross-tenant infra
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| inherited OutboxEntityBase columns | SYSTEM | BE-INTERNAL (OutboxWorker→NATS) | NONE | OK (protected `*_outbox`) |

## shared schema — 5 canonical tables

### shared.audit_logs  (`libs/backend-common/src/audit/audit-log.entity.ts`, AuditLogEntity)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/action/resource/resourceId/userId/userEmail/tenantId/schemaName/metadata/ip/userAgent/severity/correlationId/createdAt/legalHold/actorHomeTenantId/actedOnTenantId/method/mfaVerified/result/preStateHash/postStateHash/justification/relatedAuditIds | SYSTEM (AuditLogService — billing webhook, cross-service actions; infra_ledger RLS) | BE-INTERNAL + admin-api | admin-panel/audit | OK (live cross-service) |

### shared.gdpr_data_requests  (`libs/backend-common/src/security/gdpr/entities/data-request.entity.ts`, GdprDataRequest)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/userId/tenantId/requestType/status/reason/ipAddress/userAgent/requestDetails/processingDetails/downloadUrl/downloadExpiresAt/processedAt/processedBy/errorMessage/recordsAffected/createdAt/updatedAt | FE-FORM/SYSTEM (auth gdpr module + backend-common GdprService) | GRAPHQL/BE-INTERNAL | tenant-admin/gdpr | OK (live) |

### shared.user_consents  (`libs/backend-common/src/security/gdpr/entities/consent.entity.ts`, UserConsent)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/userId/tenantId/consentType/granted/version/ipAddress/userAgent/expiresAt/metadata/withdrawalReason/createdAt | FE-FORM (auth UserConsentService; messaging ai-privacy reads) | GRAPHQL + cross-service (messaging) | tenant-admin, AQUAMOBIL | OK (live cross-service) |

### shared.user_permissions  (`apps/admin-api-service/src/users/entities/user-permissions.entity.ts`, UserPermissions)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/userId/tenantId/permissions(jsonb PanelPermissions)/isActive/grantedBy/createdAt/updatedAt | FE-FORM (admin-api ONLY) | REST (admin-api ONLY; not read by token/guards) | (admin-panel checkboxes) | DUPLICATE → HIGH-001 |

### shared.access_logs  (`libs/backend-common/src/audit/access-log.entity.ts`, AccessLogEntity)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/method/path/status/durationMs/userId/tenantId/correlationId/ip/userAgent/createdAt | NONE (module never wired) | NONE | NONE | DEAD → HIGH-002 |

## libs/** — other shared `@Entity` classes (non-shared schema)

### compliance.legal_holds  (`libs/backend-common/src/compliance/legal-hold/legal-hold.entity.ts`, LegalHoldEntity)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| id/tenantId/scope/resourceId/reason/legalMatterId/appliedBy/appliedAt/releasedBy/releasedAt/releaseReason | writer not located this pass | BE-INTERNAL (protected-tables consumer) | NONE | SUSPECT → LOW-001 |

### event_store.findings  (`libs/backend-common/src/finding-registry/finding.entity.ts`, FindingEntity)
| column | writer | read | fe | class |
|--------|--------|------|----|-------|
| chainSeq/id/severity/state/title/layer/ownerAgent/... (immutable append-only) | SYSTEM (FindingRegistryService) | BE-INTERNAL (registry CLI) | NONE | OK (review-trail infra) |

---

# Appendix B — Incidental findings

_(operator directive 2026-07-11 — every deficiency noticed while tracing, including out-of-partition)_

- **INC-1 — Over-broad PUBLIC DML grant on `shared` schema.** `006-shared-schema-tables.sql:56-62` grants `SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA shared TO PUBLIC` + default privileges, justified by the (false, per HIGH-001) premise that `user_permissions` is platform-wide RBAC. RLS is the only backstop on compliance-critical tables (audit_logs, consents, gdpr requests). Re-scope grants to actual reader/writer roles. → auth-security-expert.

- **INC-2 — False enforcement claim in `access-log.module.ts`.** Docstring (`:20-26`) asserts `tests/invariants/access-log-middleware-mounted.spec.ts` enforces middleware mounting; that spec does not exist. A comment claiming a non-existent CI gate is audit theater (paired with HIGH-002). → platform-kernel-expert.

- **INC-3 — `admin-api UsersService.getTenantName` uses unqualified `FROM tenants`.** `apps/admin-api-service/src/users/users.service.ts:692` — `SELECT name FROM tenants WHERE id=$1` relies on search_path, whereas the sibling `listUsers`/`getUserById` queries correctly qualify `auth.tenants` (`:197,:355`). Latent wrong-schema/`relation does not exist` risk if search_path drifts. Fix: qualify `auth.tenants`. → admin-expert.

- **INC-4 — `any` in Stripe webhook parse path.** `stripe-webhook.controller.ts:215,525` uses `Record<string, any>` for the parsed event. This is a documented boundary (Stripe webhook is on the `boundary-files.yaml` allowlist), so acceptable — but the parsed shape should be narrowed to a typed DTO at the boundary exit before reaching `StripeWebhookService`. Noted, not blocking.

- **INC-5 — Dual audit ledgers `auth.audit_logs` vs `shared.audit_logs`.** Legitimate by design (auth needs entityType/previousValue/newValue not in the shared shape; documented at `audit/audit-log.entity.ts:20-42`). Recorded so synthesis knows the two are intentional, not drift.

- **INC-6 — `billing` schema is de-facto platform but not in the platform-level module set** (prior signal from methodology, verified: every billing `@Entity` declares `schema:'billing'` — placement correct; the classification gap is in MODULE_SCHEMAS metadata, not the entities). Low. → platform-kernel-expert.

- **INC-7 — Invoice/Plan/Payment monetary GraphQL `Float`** (see LOW-002) — lossy wire serialization over lossless DB storage; pre-tracked PLAT-LOW-001/002.
