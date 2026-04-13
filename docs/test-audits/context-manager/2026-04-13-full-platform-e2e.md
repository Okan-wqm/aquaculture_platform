# Context Manager Consolidation: `2026-04-13-full-platform-e2e`

```
BUDGET_STATUS: COMPRESSION_MANDATORY
ESTIMATED_INPUT_TOKENS: 82714
REPORT_COUNT: 15
```

## Verdict

This cycle preserves **10 CRITICAL** and **44 HIGH** findings across 15 specialist reports. Commit `79ce984f` resolved 12 findings from the 2026-04-11 cycle, but **26 prior HIGH/CRITICAL findings remain open** and 5 have been escalated by one severity level due to consecutive-cycle non-resolution.

The platform has three systemic crises:

1. **Messaging admin is a complete mock facade** (7 pages, zero backend wiring, real entities exist).
2. **AquaMobil write paths report false success** (offline queue = success boundary, no cache invalidation after mutations, cross-tenant queue replay possible on shared devices).
3. **Impersonation domain is non-functional** (field name drift, enum drift, allowedActions silently dropped -- the entire start-session path is rejected by backend DTO validation).

One finding requires `architectural-arbiter` review (see Arbiter Check section).

---

## Prior Cycle (2026-04-11) Resolution Status

### RESOLVED (11 findings across agents)

| Prior Finding | Resolved By | Verification Agent |
|---|---|---|
| tenant-isolation CRITICAL-001 (NATS fanout trusts payload tenantId) | 79ce984f | tenant-isolation-auditor |
| tenant-isolation CRITICAL-002 (UserDeleted cascade wrong schema) | 79ce984f | tenant-isolation-auditor |
| access-boundary CRITICAL-001 (MobileSettingsResolver missing role guard) | 79ce984f | access-boundary-auditor |
| access-boundary HIGH-003 (web shell accessType enforcement) | 79ce984f | access-boundary-auditor |
| chart-widget HIGH-001 (billing KPIs fabricated) | 79ce984f | chart-widget-auditor |
| chart-widget HIGH-002 (DAU synthetic multiplication) | 79ce984f | chart-widget-auditor |
| chart-widget HIGH-003 (module usage/feature adoption fake zeros) | 79ce984f | chart-widget-auditor |
| chart-widget MEDIUM-004 (chart NaN on single-point) | 79ce984f | chart-widget-auditor |
| realtime-sync HIGH-003 (tenant-admin cache keys for activity/device) | 79ce984f | realtime-sync-auditor |
| workflow-state HIGH-001 through HIGH-004 (task event, previousStatus, maintenance resurrect, archive leftAt) | 79ce984f | workflow-state-auditor |
| data-readback high-003 (analytics synthetic DAU) | 79ce984f | data-readback-auditor |
| data-readback medium-002 (tenant user search current-page) | 79ce984f | data-readback-auditor |

### STILL OPEN (26+ findings carried into this cycle with escalation)

All prior form-write-auditor, file-transfer-auditor, mobile-app-auditor, contract-parity-auditor, and table-grid-auditor findings remain open. Findings open for two consecutive cycles have been escalated per operating instructions.

---

## Preserved CRITICAL Findings (10)

| # | Source Agent | Original ID | Gap Class | Verbatim Finding |
|---|---|---|---|---|
| C1 | ui-action-mapper | CRITICAL-001 | write-gap, access-gap | Impersonation `allowedActions` checkboxes are rendered but never transmitted -- operator sees action-scope controls that have zero backend effect. ESCALATED from prior HIGH-001 (2nd cycle open). |
| C2 | ui-action-mapper | CRITICAL-002 | write-gap | GDPR data subject request actions (verify/reject/complete) are `console.log`-only no-ops. Modal closes, data reloads, backend state unchanged. Regulatory false-assurance surface. |
| C3 | tenant-isolation | CRITICAL-001 | tenant-gap, sync-gap | SensorReading NATS bridge subscribes to `events.SensorReading` but publisher uses `events.{tenantId}.SensorReading` -- receives ZERO events in production. If naive fix applied, the payload-trust vulnerability resurfaces. |
| C4 | tenant-isolation | CRITICAL-002 | tenant-gap, access-gap | TenantProvisioned event uses non-tenant-scoped subject. No NATS ACL enforcement confirmed. Compromised container can trigger partition creation for arbitrary tenants. |
| C5 | button-action | CRITICAL-001 | write-gap | MaintenancePage handlers produce false success on API failure: catch blocks apply identical state mutations as success path. Admin believes maintenance started/ended when backend rejected. |
| C6 | button-action | CRITICAL-002 | write-gap | JobQueuePage retry/pause/resume handlers same anti-pattern: catch blocks mirror success. Failed retries appear successful. |
| C7 | button-action | CRITICAL-003 | write-gap, sync-gap | Mobile record pages treat offline-queue insertion (`addToQueue`) as confirmed business success. Harvest/mortality/cull/transfer/leave/attendance show green checkmark before any backend roundtrip. ESCALATED from prior HIGH-001 (2nd cycle). |
| C8 | schema-surface-parity | CRITICAL-001 | schema-gap, write-gap | MessagingCompliancePage is complete mock facade over real compliance entities (ComplianceAuditLog, LegalHold, RetentionPolicy). Shows "Compliance Score: 100%" and "Active Holds: 0" regardless of real state. |
| C9 | schema-surface-parity | CRITICAL-002 | schema-gap, access-gap | AI persona admin page is static mock -- 16+ durable `TenantAgentConfig` fields (including LIFE-SAFETY `actuationPolicy`, `autonomousSafetyLimits` for PLC actuation) have no product surface. ESCALATED from prior HIGH-001 (2nd cycle). |
| C10 | realtime-sync | CRITICAL-001 | tenant-gap, sync-gap | Sensor module Zustand stores are global singletons with no tenant partition. On tenant switch, prior-tenant SCADA readings persist in stores indefinitely if deviceCodes overlap. |
| C11 | mobile-app | CRITICAL-001 | tenant-gap, write-gap | Offline queue `StoredOperation` has no tenantId. syncAllOperations replays ALL pending ops under the CURRENT auth context. Cross-tenant data mutation possible on shared devices. |

> Note: C1 and C9 have been open for two consecutive cycles. C7 has been open for two consecutive cycles.

---

## Preserved HIGH Findings (44)

### Tenant Isolation & Access Boundary (8)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H1 | tenant-isolation | HIGH-001 | tenant-gap | AlertAuditService `getById`, `getByCorrelationId`, `getEntityHistory` lack tenantId in WHERE -- cross-tenant audit reads |
| H2 | tenant-isolation | HIGH-002 | tenant-gap, access-gap | ChannelMemberGuard and MessageOwnerGuard query without tenant filter -- cross-tenant bypass if schema middleware fails |
| H3 | tenant-isolation | HIGH-003 | tenant-gap | WeatherSyncService `cleanupOldData` has no tenant filter -- deletes weather data across ALL tenants |
| H4 | tenant-isolation | HIGH-004 | tenant-gap | NotificationService `markAsRead` has no tenantId filter -- cross-tenant notification state mutation |
| H5 | access-boundary | HIGH-001 | access-gap | AquaMobil `checkMobileEnabled` returns `true` on error; `loginWithToken` (WebAuthn) skips `accessType` check; `FALLBACK_SETTINGS` all-true on error+no cache |
| H6 | access-boundary | HIGH-002 | access-gap | AquaMobil `restoreSession` bypasses both `accessType` and `isMobileEnabled` checks -- revoked mobile users auto-restored |
| H7 | access-boundary | HIGH-003 | access-gap | `TenantAdminResolver.myModules` query has no role guard -- any authenticated user can enumerate all tenant modules |
| H8 | realtime-sync | HIGH-004 | tenant-gap, sync-gap | `useTenantData` 20+ query keys have no tenantId prefix. 5-minute staleTime cross-tenant exposure window on impersonation/switch. |

### Impersonation Domain (4)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H9 | contract-parity | HIGH-001 | write-gap, schema-gap | Impersonation start sends `tenantId`/`impersonatedUserId` but backend requires `targetTenantId`/`targetUserId`; reason is free-text but enum-validated. DTO rejects request. REPEAT 2nd cycle. |
| H10 | contract-parity | HIGH-002 | access-gap, schema-gap | Grant-permission collects `allowedActions` but drops it; backend has `ImpersonationPermissions` typed struct, not string array. REPEAT 2nd cycle. |
| H11 | contract-parity | HIGH-006 | schema-gap | Session status `revoked` in frontend vs `terminated` in backend -- terminated sessions misrepresented. |
| H12 | button-action | HIGH-002 | access-gap, write-gap | Impersonation privileged actions lack per-action loading state -- double execution possible for start/end/grant/extend/revoke. REPEAT 2nd cycle. |

### Messaging Admin Mock Facade (2)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H13 | ui-action-mapper | HIGH-001 | write-gap, read-gap | All 7 messaging admin pages (Retention, Compliance, Monitoring, Audit, Tenants, AI Dashboard, AI Personas) use MOCK_* constants, commented-out API calls, local-state-only writes. |
| H14 | schema-surface-parity | HIGH-002 | schema-gap, read-gap | Confirms H13 from schema perspective -- 5 additional messaging admin sub-pages are mock facades with mature backend entities unused. |

### AquaMobil Messaging Wiring (5)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H15 | mobile-app | HIGH-001 | write-gap | AttachmentPicker component and useMediaUpload hook fully implemented but never mounted in ChatRoomPage. REPEAT 2nd cycle. |
| H16 | mobile-app | HIGH-002 | write-gap | VoiceRecorder works, output blob silently discarded. REPEAT 2nd cycle. |
| H17 | mobile-app | HIGH-003 | write-gap | Message delete handler is TODO stub; delete button renders for own messages. REPEAT 2nd cycle. |
| H18 | mobile-app | HIGH-004 | read-gap | Media viewer `useChannelMedia` hardcoded empty. REPEAT 2nd cycle. |
| H19 | form-write-auditor | HIGH-004 | write-gap | "Add Member" button on ChannelSettingsPage has no onClick despite `ADD_CHANNEL_MEMBER` GraphQL op existing. |

### Farm & Data Readback (5)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H20 | data-readback | HIGH-001 | read-gap, schema-gap | Tenant user edit preload missing `roleId` and `phoneNumber` -- role starts unselected, phone blanked on save. REPEAT 2nd cycle. |
| H21 | data-readback | HIGH-002 | read-gap, write-gap | FarmDetailPage, FarmListPage, FarmFormPage render entirely mock data despite real hooks existing. |
| H22 | data-readback | HIGH-003 | read-gap | FarmDetailPage sensor data and chart are hardcoded mock -- LIFE-SAFETY adjacent (dissolved oxygen affects fish mortality). |
| H23 | form-write-auditor | HIGH-001 | write-gap, sync-gap | AquaMobil leave submission writes server state but never invalidates `leaveRequests`/`leaveBalances` cache. REPEAT 2nd cycle. |
| H24 | form-write-auditor | HIGH-003 | write-gap, schema-gap | Channel edit button rendered, no onClick, no modal, no mutation wiring. REPEAT 2nd cycle. |

### Workflow State Machines (5)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H25 | workflow-state | HIGH-001 | write-gap | `completeTask` bypasses VALID_TRANSITIONS -- allows PENDING->COMPLETED directly, contradicting declared state machine. |
| H26 | workflow-state | HIGH-002 | write-gap | Equipment update handler bypasses tank `canTransitionTo` -- unrestricted status-change backdoor. |
| H27 | workflow-state | HIGH-003 | write-gap | Employee status has zero transition validation -- TERMINATED->ACTIVE allowed via `Object.assign`. |
| H28 | workflow-state | HIGH-004 | write-gap, sync-gap | Cancel-leave-request publishes event AFTER commit via fire-and-forget eventBus, not outbox. Asymmetric guarantee vs approve path. |
| H29 | workflow-state | HIGH-005 | write-gap | Goal `updateGoal` accepts any status without transition validation, bypassing dedicated complete/defer handlers. |

### Chart & Dashboard Truth (4)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H30 | chart-widget | HIGH-001 | read-gap, visibility-gap | Churn Rate KPI trend hardcoded as -0.5/down regardless of actual data. |
| H31 | chart-widget | HIGH-002 | read-gap, visibility-gap | "Aktif Kullanici" MetricCard trend shows `sensorsTrend` (sensor health %) not user activity. |
| H32 | chart-widget | HIGH-003 | read-gap, visibility-gap | "Toplam Kullanici" MetricCard trend shows `productionTrend` (biomass %) not user growth. |
| H33 | chart-widget | HIGH-004 | read-gap, visibility-gap | HR "Active Certifications" card shows `expiringCertsCount` (2) instead of total active (200). SAFETY-RELEVANT. |

### Table/Grid Sort & Export (5)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H34 | table-grid | HIGH-001 | read-gap, visibility-gap | EmployeesListPage sort state never reaches GraphQL -- cosmetic only. |
| H35 | table-grid | HIGH-002 | read-gap, visibility-gap | AuditLogPage columns sortable=true but no `sorting` prop to Table. |
| H36 | table-grid | HIGH-003 | read-gap, visibility-gap | TenantManagementPage columns sortable=true but no `sorting` prop. |
| H37 | table-grid | HIGH-004 | read-gap, visibility-gap | UserManagementPage columns sortable=true but no `sorting` prop. |
| H38 | table-grid | HIGH-005 | read-gap, visibility-gap | FarmListPage mock data, no sort wiring, inert pagination onChange. |

### File Transfer (4)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H39 | file-transfer | HIGH-002 | write-gap | Chemical document upload/delete non-atomic -- blob orphans or dangling refs. REPEAT 2nd cycle. |
| H40 | file-transfer | HIGH-003 | write-gap, schema-gap | SCADA PDF export uses /FlateDecode on raw PNG bytes -- structurally invalid. REPEAT 2nd cycle. |
| H41 | file-transfer | HIGH-006 | write-gap, schema-gap | Chemical document upload passes `undefined` url due to backend response returning `path` not `url`. |
| H42 | file-transfer | HIGH-007 | write-gap | Messaging tenant export is console.log stub despite backend DataExportService being fully implemented. |

### Contract Parity & Enums (3)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H43 | contract-parity | HIGH-003 | write-gap, schema-gap | AquaMobil leave creation omits `employeeId` (required), `totalDays` (required), wrong `isHalfDay` shape. REPEAT 2nd cycle. |
| H44 | contract-parity | HIGH-004 | schema-gap | TenantStatus enum lowercase in FE vs UPPERCASE in BE -- all filter/comparison fails. |
| H45 | contract-parity | HIGH-005 | schema-gap | PlanTier enum missing `FREE` in backend -- subscription creation fails for free-tier tenants. |

### List Visibility & Cache (4)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H46 | list-visibility | HIGH-001 | visibility-gap, sync-gap | AquaMobil task actions do not invalidate any list cache after write. |
| H47 | list-visibility | HIGH-002 | visibility-gap, sync-gap | Offline queue sync completes 14 operation types but never refreshes any React Query caches. |
| H48 | list-visibility | HIGH-003 | visibility-gap | Admin-panel announcement + messaging mutations (12 hooks) bypass React Query entirely. Stale lists until page reload. |
| H49 | schema-surface-parity | HIGH-003 | schema-gap | Tool execution audit entity has no product surface. ESCALATED from prior MEDIUM (2nd cycle). |

### Remaining Schema-Surface HIGH (3)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H50 | schema-surface-parity | HIGH-001 | schema-gap | Config-service Configuration + ConfigurationHistory have no product-facing CRUD. REPEAT 2nd cycle. |
| H51 | schema-surface-parity | HIGH-004 | schema-gap | ScheduledPlanChange entity invisible to operators -- billing cron applies changes silently. |
| H52 | schema-surface-parity | HIGH-005 | schema-gap, access-gap | GdprDataRequest lifecycle + UserConsent records partially orphaned from UI. |

### Remaining Operational HIGH (4)

| # | Source Agent | Original ID | Gap Class | Summary |
|---|---|---|---|---|
| H53 | realtime-sync | HIGH-001 | sync-gap, visibility-gap | AquaMobil notification fallback poll refreshes badge only, never the list. REPEAT 2nd cycle. |
| H54 | realtime-sync | HIGH-002 | sync-gap | Offline queue auto-sync latches on zero-success runs. REPEAT 2nd cycle. |
| H55 | realtime-sync | HIGH-005 | sync-gap, tenant-gap | Alert history polling has no tenant scope and no error backoff. |
| H56 | button-action | HIGH-004 | write-gap | TenantUsers Export button is a no-op -- no onClick handler. |
| H57 | button-action | HIGH-005 | write-gap | Tenant activate action in detail modal -- no loading state, no error display in modal. |
| H58 | button-action | HIGH-006 | write-gap | Database schema suspend/activate uses confirm(), inline `.then()` with no `.catch()`. |
| H59 | button-action | HIGH-003 | write-gap | Feature toggle status change no in-flight guard, `confirm()` for production flag delete. |
| H60 | file-transfer | HIGH-004 | write-gap | Invoice PDF download placeholder. REPEAT 2nd cycle. |
| H61 | ui-action-mapper | HIGH-005 | visibility-gap | Security Dashboard has no action controls for events/incidents despite API methods existing. |
| H62 | form-write-auditor | HIGH-005 | write-gap | ChatRoomPage attachment + voice recording handlers empty TODO stubs. |

---

## MEDIUM Findings -- Compacted by Category

| Category | Count | Representative Pattern | Contributing Agents |
|---|---|---|---|
| React Query cache keys missing tenantId | 7 | TenantDashboard, HR module (6 key factories), AquaMobil messaging invalidation patterns use non-tenant-prefixed keys | tenant-isolation, realtime-sync |
| Client-side search on server-paginated data | 5 | TenantUsers, CertificationDashboard, PayrollPage, EmployeeSearch, DirectReports -- search filters current page slice only | table-grid, data-readback, list-visibility |
| Inert Export buttons (no onClick) | 4 | EmployeesList, Attendance, CertificationDashboard, TenantUsers | table-grid, button-action |
| HR DataTable sort is display-only | 1 (systemic) | HR DataTable component accepts sort props but never reorders data; affects 7+ HR pages | table-grid |
| Browser confirm()/prompt() for destructive actions | 25+ instances | Farm setup tabs (7), sensor module (6 incl. EMERGENCY STOP), admin system pages (3+) | button-action |
| Schema-surface partial parity | 5 | FeatureToggle 9 hidden fields, MaintenanceMode 8 hidden fields, RegulatorySettings split, NotificationLog no surface, TenantAiSetting/UserAiConsent no surface | schema-surface-parity |
| Fire-and-forget event publish (not outbox) | 3 | Leave cancel, task overdue cron, billing ALL handlers (no OutboxPublisher import) | workflow-state |
| Enum/contract divergence (MEDIUM tier) | 5 | DataRequestType erasure/deletion mismatch, Analytics types drift, FeedingMethod string/enum, TenantTier custom/trial, ImpersonationPermission fields | contract-parity |
| AquaMobil leave/channel cache staleness | 3 | Leave submit/cancel no invalidation, channel accumulated ref diverges on paged scroll + update | list-visibility, mobile-app |
| Mobile service worker message contract | 3 | SW posts SYNC_MESSAGES/NAVIGATE_TO_CHANNEL, nobody listens; sync label coverage 4 of 17 types; global last_sync_at key | mobile-app |
| Admin panel billing/access non-standard auth | 2 | BillingResolver inline `requireRoles()`, ConfigurationResolver `checkAdminAccess()` with lowercase role names | access-boundary |
| Chart/widget rendering issues | 4 | MiniChart NaN guard, HR analytics 0% bars, backend chart endpoints hardcoded zeros, console.error in analytics | chart-widget |
| File transfer/export gaps | 5 | Shared DataTable CSV exports current page only, batch doc field mismatch, hydroponics download stub, audit CSV escaping, recipe import silent error | file-transfer |
| Workflow transition divergence | 2 | Tank transition map entity vs handler disagreement, alert incident suppress() no state guard | workflow-state |
| Mobile offline UX gaps | 3 | No visibilitychange refresh, offline messages dual-queue (useSendMessage path never drained), cache clear blasts all tenants | mobile-app |
| Overrestrictive guards | 3 | Announcement, support ticket, support messaging resolvers gate all ops behind TenantAdminOrHigher | access-boundary |

**Total MEDIUM: ~82 findings compacted into 16 categories**

---

## LOW Findings -- Count Only

**Total LOW: ~22 findings** across console.log violations, cosmetic label errors, single-point chart rendering, dark mode/WebAuthn localStorage scoping, pagination disconnects, and informational contract drift.

---

## Deduplicated Root-Cause Families

### Family 1: Messaging Admin Mock Facade
**Contributing findings:** C8, H13, H14, H42 (+ file-transfer HIGH-007, HIGH-008)
**Contributing agents:** ui-action-mapper, schema-surface-parity, file-transfer-auditor, form-write-auditor, data-readback-auditor
**Root cause:** All 7 messaging admin pages were scaffolded mock-first and never wired. Backend has mature entities (ComplianceAuditLog with partitions, LegalHold with GDPR fields, RetentionPolicy, DataExportService). The admin API gateway layer connecting admin-panel to messaging-service backend does not exist.
**Gap class:** schema-gap + write-gap + read-gap

### Family 2: AquaMobil False-Success Write Pipeline
**Contributing findings:** C7, C11, H15-H19, H23, H24, H46, H47, H53, H54, H62
**Contributing agents:** button-action, mobile-app, form-write-auditor, list-visibility, realtime-sync
**Root cause:** Three interlocking issues: (a) `addToQueue()` insertion treated as success boundary with no "queued" vs "confirmed" distinction, (b) mutation hooks use manual useState instead of React Query so no invalidation possible, (c) syncAllOperations is generic fire-and-forget with no query-key awareness. Additionally, the queue store has no tenantId (C11), creating cross-tenant replay risk.
**Gap class:** write-gap + sync-gap + tenant-gap + visibility-gap

### Family 3: Impersonation Domain Non-Functional
**Contributing findings:** C1, H9, H10, H11, H12 (+ contract-parity MEDIUM-009)
**Contributing agents:** ui-action-mapper, contract-parity, button-action, access-boundary
**Root cause:** Frontend types carry a legacy model that diverged from the backend on field names (`tenantId` vs `targetTenantId`), reason validation (free-text vs enum), status values (`revoked` vs `terminated`), and permission structure (`string[]` vs `ImpersonationPermissions`). The session start path is completely rejected by backend DTO validation. The allowedActions UI control has no backend representation. No shared contract ownership exists.
**Gap class:** schema-gap + access-gap + write-gap

### Family 4: Tenant-Scoped Cache Isolation Incomplete
**Contributing findings:** C10, C11, H8, H55 (+ 7 MEDIUM cache key findings)
**Contributing agents:** realtime-sync, tenant-isolation, mobile-app
**Root cause:** Commit 79ce984f fixed two specific hooks but did not establish a systematic fix. The `tenantKeys` factory in `useTenantData.ts` drives 20+ queries without tenantId. Zustand sensor stores are global singletons. The offline queue has no tenant partitioning. Alert polling uses manual setInterval with no tenant scope.
**Gap class:** tenant-gap + sync-gap

### Family 5: Farm Module Core Pages Mock-Backed
**Contributing findings:** H21, H22, H38
**Contributing agents:** data-readback, table-grid
**Root cause:** FarmListPage, FarmDetailPage, FarmFormPage all use hardcoded mock data/constants despite real GraphQL hooks (`useSiteList`, `useSite`, `useCreateSite`, `useUpdateSite`) and sensor hooks existing. The farm module is the primary domain of the platform. Sensor mock data on FarmDetailPage is LIFE-SAFETY adjacent.
**Gap class:** read-gap + write-gap + visibility-gap

### Family 6: Workflow State Machine Bypass via Generic Update Paths
**Contributing findings:** H25, H26, H27, H29 (+ MEDIUM-001 alert suppress, MEDIUM-002 tank map divergence)
**Contributing agents:** workflow-state
**Root cause:** Dedicated lifecycle handlers (with transition maps, business rules) coexist with generic CRUD `update()` paths that accept status fields directly. Task, Tank, Employee, and Goal entities all have this dual-entry-point pattern where the generic path bypasses validation.
**Gap class:** write-gap

### Family 7: Event Delivery Guarantee Asymmetry
**Contributing findings:** H28 (+ MEDIUM-003 task overdue, MEDIUM-004 billing all handlers)
**Contributing agents:** workflow-state
**Root cause:** Outbox migration is incomplete. Within the same bounded context, some handlers use OutboxPublisher (at-least-once) while others use fire-and-forget eventBus.publish (at-most-once). Billing-service has zero OutboxPublisher usage. Leave approve = outbox; leave cancel = eventBus. This makes delivery guarantee reasoning impossible for consumers.
**Gap class:** write-gap + sync-gap

### Family 8: Paginated Table False Sort Affordance
**Contributing findings:** H34-H38 (+ MEDIUM-010 HR DataTable display-only sort)
**Contributing agents:** table-grid
**Root cause:** Two distinct failures: (a) admin-panel pages mark columns `sortable: true` but never pass `sorting` prop to shared Table (4 pages); (b) HR module's local DataTable component accepts sort props but never sorts data (7+ pages). No backend query accepts sort parameters.
**Gap class:** read-gap + visibility-gap

### Family 9: Chart/Dashboard Trend-Value Semantic Mismatch
**Contributing findings:** H30, H31, H32, H33
**Contributing agents:** chart-widget
**Root cause:** KPI card values are correct but trend indicators come from unrelated data sources (sensorsTrend, productionTrend, hardcoded -0.5) or wrong counts (expiringCerts instead of activeCerts). No `KpiTrendBinding` type enforces semantic domain consistency.
**Gap class:** read-gap + visibility-gap

### Family 10: File Upload Response Field Mismatch
**Contributing findings:** H39, H40, H41 (+ MEDIUM-012 batch doc storageUrl)
**Contributing agents:** file-transfer
**Root cause:** Backend upload controller returns `{ path, etag, size, contentType }` but frontend expects `url` / `storageUrl` / `storagePath`. Chemical and batch document uploads succeed at MinIO level but the domain-association step fails because the URL/path field is undefined. SCADA PDF has a separate codec mismatch (FlateDecode on raw PNG).
**Gap class:** write-gap + schema-gap

### Family 11: Contract Enum Divergence
**Contributing findings:** H44, H45, H11 (+ 5 MEDIUM enum findings)
**Contributing agents:** contract-parity
**Root cause:** No shared contract between frontend and backend for TenantStatus (case), PlanTier (FREE missing), ImpersonationStatus (revoked/terminated), DataRequestType (erasure/deletion), TenantTier (custom/trial). Each layer maintains independent enum definitions.
**Gap class:** schema-gap

---

## Gap Dependency Graph

```
tenant-gap ─────────────────────────────────────────────┐
  C3 SensorReading subject mismatch                      │
  C4 TenantProvisioned no ACL                            │
  C10 Zustand stores global singletons                   │
  C11 Offline queue no tenantId                          │
  H1-H4 Backend queries missing tenant WHERE             │
  H8 useTenantData 20+ keys unscoped                    │
    │                                                    │
    v                                                    │
sync-gap ──────────────────────────────────────┐         │
  C7 Offline queue = success boundary           │         │
  H28 Leave cancel fire-and-forget              │         │
  H47 Offline sync no cache invalidation        │         │
  H53 Notification poll badge-only              │         │
  H54 Auto-sync zero-success latch              │         │
    │                                           │         │
    v                                           v         v
write-gap ──────────────────────────────────────────────────┐
  C1 allowedActions silently dropped                        │
  C2 GDPR actions console.log only                          │
  C5 Maintenance false success                              │
  C6 JobQueue false success                                 │
  H9 Impersonation start rejected by DTO                    │
  H13 Messaging admin write paths mock-only                 │
  H15-H19 AquaMobil messaging wiring gaps                   │
  H25-H29 State machine bypasses                            │
  H39-H42 File upload field mismatches                      │
    │                                                       │
    v                                                       │
read-gap ─────────────────────────────────────────────┐     │
  H20 User edit preload missing fields                 │     │
  H21-H22 Farm pages mock data                         │     │
  H30-H33 Chart trend semantic mismatch                │     │
  H34-H38 Sort affordance false                        │     │
  H18 Media viewer empty                               │     │
    │                                                  │     │
    v                                                  v     v
visibility-gap ──────────────────────────────────────────────
  H46 Task list stale after mutation
  H47 All mobile lists stale after sync
  H48 Admin panel lists stale after mutations
  C8 Compliance 100% / 0 holds regardless of reality
  H61 Security dashboard read-only
```

**Key dependency chains:**
- `tenant-gap` (C11 queue no tenantId) -> `sync-gap` (H47 sync replays under wrong context) -> `write-gap` (cross-tenant mutations) -> `read-gap` (wrong tenant data displayed)
- `schema-gap` (H44 enum case mismatch) -> `write-gap` (filter rejects) -> `read-gap` (empty results) -> `visibility-gap` (operator sees no data)
- `write-gap` (C5/C6 false success) -> `visibility-gap` (admin sees changed state that backend rejected)

---

## Systemic Patterns (recurring across 3+ agents)

### Pattern 1: "Demo Fallback" / "Mock Facade" Anti-Pattern
**Recurrence:** 7+ agents (ui-action-mapper, form-write-auditor, schema-surface-parity, data-readback, button-action, file-transfer, chart-widget)
**Description:** Pages render full interactive UIs backed by MOCK_* constants, `console.log`-only handlers, or catch blocks that mirror the success path. The user cannot distinguish success from failure, or real data from static placeholders.
**Highest-risk surfaces:** Messaging admin (7 pages), GDPR compliance actions, maintenance/job queue admin, farm core pages.

### Pattern 2: Mutation Without Cache Invalidation
**Recurrence:** 5 agents (form-write-auditor, list-visibility, mobile-app, data-readback, realtime-sync)
**Description:** Write operations succeed (or are queued) but no React Query cache invalidation follows. The visible list/detail/badge remains stale until staleTime expires, manual reload, or remount. AquaMobil is worst -- uses manual useState hooks alongside React Query with no bridge.
**Highest-risk surfaces:** AquaMobil tasks, leave, offline sync (all 14 op types), admin announcements/messaging (12 mutation hooks).

### Pattern 3: Frontend/Backend Enum Divergence (No Shared Contract)
**Recurrence:** 3 agents (contract-parity, schema-surface-parity, data-readback)
**Description:** Frontend and backend maintain independent enum definitions for the same domain concept. Values differ in casing, membership, or naming. No shared contract generation or validation exists.
**Highest-risk surfaces:** TenantStatus, PlanTier, ImpersonationStatus/Reason, DataRequestType/Status.

### Pattern 4: Parallel Update Paths Bypass State Machine
**Recurrence:** 3 agents (workflow-state, form-write-auditor, button-action)
**Description:** Dedicated lifecycle handlers with transition validation coexist with generic CRUD update paths that accept status directly without consulting the transition map. Task, Tank, Employee, Goal entities all exhibit this.
**Recommendation:** Remove `status` from generic update DTOs; route all status changes through dedicated commands.

### Pattern 5: False Sort Affordance on Paginated Grids
**Recurrence:** 3 agents (table-grid, data-readback, contract-parity)
**Description:** Column headers declare `sortable: true` and render sort icons, but clicking them either does nothing (admin-panel pages) or toggles icons without reordering data (HR pages). No backend query accepts sort parameters.
**Affected surfaces:** EmployeesList, AuditLog, TenantManagement, UserManagement, FarmList, and all HR DataTable consumers.

### Pattern 6: Repeated Unfixed Findings (Stale Systemic Debt)
**Recurrence:** 6+ agents
**Description:** 26+ findings from the 2026-04-11 cycle remain open. Zero form-write-auditor findings were resolved. Zero file-transfer findings were resolved. Zero mobile-app findings were resolved. Zero contract-parity findings were resolved. Commit 79ce984f addressed tenant-isolation, access-boundary, chart-widget, workflow-state, and realtime-sync domains, but left the AquaMobil wiring, messaging admin, impersonation domain, and file transfer surfaces entirely untouched.

---

## Arbiter Check

### Conflict Detected: Offline Queue Success Boundary

**button-action-auditor** recommends a two-phase success UX: "Queued" indicator first, then "Confirmed" only after backend sync callback succeeds.

**mobile-app-auditor** identifies that `useSendMessage` uses a SEPARATE offline queue path (`messaging_offline_sends` cache) that is NEVER drained on reconnect, while the general offline queue handles other message operations (edit, delete, markRead). These are two different storage and sync mechanisms for the same domain.

**Potential conflict:** If the "queued then confirmed" pattern is applied to the general offline queue only, messaging offline writes via `useSendMessage.queueOffline()` remain permanently unsynced. The fix direction must address BOTH queue paths -- either consolidate them or apply the two-phase pattern to both.

**Recommendation:** Escalate to `architectural-arbiter` to determine whether to (a) consolidate all offline writes into a single queue with tenant-scoped keys and sync-complete cache invalidation, or (b) maintain the dual-queue architecture with explicit drain logic for the messaging path.

### No Other Conflicts Detected

All other overlapping findings across agents converge on the same root causes and compatible fix directions. No recommendation contradictions were found.

---

## Deployment Blockers

The following findings **block deployment confidence** until resolved:

1. **C3** (SensorReading NATS subject mismatch) -- zero real-time sensor data in production
2. **C4** (TenantProvisioned no ACL) -- arbitrary tenant partition creation possible
3. **C11** (Offline queue no tenantId) -- cross-tenant data mutation on shared devices
4. **C5/C6** (Admin false success on API failure) -- maintenance and job queue admin actions lie to operators

---

## Notes

- No source-code changes were made by this consolidation.
- All file paths reference `/var/aqua-saas/` repository root.
- Budget compression applied: MEDIUM findings grouped into 16 categories (82 individual findings), LOW findings counted only (22).
- Preserved finding IDs are verbatim from source agents; context-manager synthesis IDs use the C# and H# shorthand for cross-referencing within this document only.
