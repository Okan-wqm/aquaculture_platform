# DB Audit — HR / Messaging / AI Partition (Lane-D) — 2026-07-11

**Auditor:** db-audit-people-messaging (Lane-D, CATCHER, secondary reviewer)
**Cycle date:** 2026-07-11
**Finding ID prefix:** `DB-PEOPLE-{SEVERITY}-{NNN}`

## Scope

Durable-column provenance + read-exposure + frontend-reachability audit of:
- `apps/hr-service` — 31 `@Entity` classes, schema-per-tenant `hr`.
- `apps/messaging-service` — 18 `@Entity` classes, schema-per-tenant `messaging` (partitioned `messages`/`message_receipts`, retention/legal-hold, GDPR ops).
- `apps/ai-service` — 4 live `@Entity` classes, schema-per-tenant `ai` (agent config, conversations, tool-execution audit, outbox; cross-tenant `tool_execution_audit`).
- FE reachability: `web/modules/hr-module`, `web/modules/messaging-module`, `web/apps/aquamobil` (live messaging + AI chat + attendance).

Read-only over source. Every table appears in Appendix A (grouped-column provenance matrix); every incidental defect in Appendix B. Federation confirmed: `hr`, `messaging`, `ai` are all registered subgraphs (`infrastructure/apollo-router/subgraphs.json:40-109`), so their GraphQL fields reach the product.

## Executive summary

The messaging + AI safety machinery is genuinely well-built and the four domain CRITICAL invariants all hold: **legal-hold precedence is enforced on every destructive path** (retention cron, GDPR anonymise, delete-message, and a Tier-1 branded-token guard for partition drops — all fail-closed); **partitioned-table DML grants are grant-complete** via `ALTER DEFAULT PRIVILEGES` + the SECURITY DEFINER `create_messaging_partition` primitive; **BYOK provider keys are AES-256-GCM at rest and never returned unmasked** (last-4 hint only); and **cost/tool-audit writes are provider-agnostic** (fire once in the provider-neutral runner + on every tool-executor branch). No CRITICAL findings. The headline defect is HR frontend contract drift far exceeding the documented floor (DB-PEOPLE-HIGH-001): the hr-module payroll + performance/goal operations are structurally invalid against the live `hr` subgraph. Secondary: employee contact PII exposed to the broad `MODULE_USER` role (DB-PEOPLE-MEDIUM-001); AI cost tracking has no durable per-invocation ledger (DB-PEOPLE-MEDIUM-002); tool-audit durability is best-effort / fail-open (DB-PEOPLE-MEDIUM-003); AI conversation history is double-modeled across services (DB-PEOPLE-MEDIUM-004).

**Wave-1 cross-check (support-conversation duplication):** messaging-service holds NO third overlapping *support-conversation* model. Its `channels`/`messages` are a distinct team-chat + in-channel-AI product reachable from different UI than auth's `message_threads`/`support_tickets` (DB-IDENT-MEDIUM-001). The genuine duplication is inside the AI domain — see DB-PEOPLE-MEDIUM-004.

## Findings (by severity)

### HIGH

#### DB-PEOPLE-HIGH-001 — hr-module payroll + performance GraphQL operations are structurally invalid against the live `hr` subgraph (full extent of the documented drift)

**Severity:** HIGH · **Layer:** 1 (GraphQL contract) · **State:** OPEN · **Class:** UI-WITHOUT-DB / MISSING-FIELD

`codegen.ts` documents `Payroll.earnings/deductions` and `PerformanceGoal.keyResults` as known drift. Auditing ALL hr-module operations against the compiled subgraph SDL (`dist/graphql/subgraphs/hr.graphql`) shows the drift breaks whole surfaces:

1. **`Payroll.earnings` / `Payroll.deductions` do not exist on the read type.** The entity flattened them to typed columns; the getters (`payroll.entity.ts:213-236`) carry NO `@Field`, so the subgraph `Payroll` exposes only `earningsBaseSalary…deductionsTotal` (`hr.graphql:157-192`). `PAYROLL_FRAGMENT` (`web/modules/hr-module/src/graphql/fragments.ts:603-618`) selects `earnings{…}`/`deductions{…}` → gateway validation 400. Breaks all 4 payroll ops (`payroll.operations.ts:12-71`).
2. **Object-list fields selected as scalars.** `GOAL_FRAGMENT` selects `keyResults` and `milestones` with no subselection (`fragments.ts:569,572`); subgraph types are `[KeyResult!]`/`[GoalMilestone!]` (`hr.graphql:972-1016`). `PERFORMANCE_REVIEW_FRAGMENT` selects `competencyRatings` as a scalar (`fragments.ts:535`) but it is `[CompetencyRating!]` (`hr.graphql:911-936`). GraphQL requires a subselection → validation error breaks every goal + performance-review op. (Note: the drift doc's `PerformanceGoal` type is actually `Goal`; the fragment targets `on Goal` correctly — the fault is the missing subselection.)
3. **Five FE operations reference queries/mutations absent from the subgraph** (`hr.graphql:1564-1718`): `teamPerformanceOverview` (`performance.operations.ts:62`), `reviewCycleStatus` (:117), `goalProgressTrend` (:204), `departmentKPIs` (:245), mutation `bulkCreateReviews` (:320). Each 400s at the gateway.

**Rule violated:** ADR-009 data-fetch + orphaned codegen (layer-1-react §GraphQL codegen). hr-module ops are hand-written and NOT codegen-validated → ship and fail only at runtime.

**Proposed fix direction**
- Rewire hr-module through codegen against the federated supergraph (client-preset + fragment masking) so field/query non-existence is a compile error (Tier-1).
- Interim: CI job validating the hand-written documents against the composed schema.
- Fix fragments (flattened columns; add subselections; delete/implement the 5 missing ops).

**Ripple set:** `web/modules/hr-module/src/graphql/{fragments,payroll.operations,performance.operations}.ts` + consuming components; hr-service resolvers if the 5 ops are intended real.
**Expected closer:** frontend-expert WRITER (codegen) + hr-expert (confirm real-vs-dead ops).

### MEDIUM

#### DB-PEOPLE-MEDIUM-001 — Employee contact PII (home address, personal + emergency phone) exposed to the broad `MODULE_USER` role with no object-level scoping

**Severity:** MEDIUM (candidate HIGH per tenant-RBAC grant of `MODULE_USER`) · **Layer:** 2 (object-level authz) + PII invariant · **State:** OPEN · **Class:** OK-but-over-exposed

`Employee.contactInfo` (`{email,phone,emergencyContact,emergencyPhone}`) and `Employee.address` (full home address) are `@Field`-exposed (`employee.entity.ts:207-213`) on the federated `employee(id)`/`employees` queries, which are gated to `TENANT_ADMIN, MODULE_MANAGER, MODULE_USER` (`hr.resolver.ts:75-97`) — the lowest role can fetch ANY employee by id with no self/manager-chain check. Any `MODULE_USER` can read every colleague's home address, personal phone, and emergency contacts, unmasked. The truly sensitive columns ARE protected (`nationalId`/`bankDetails` AES-256-GCM + `@HideField`; `dateOfBirth`/`baseSalary`/`emergencyInfo` `@HideField`), which is why this is MEDIUM not CRITICAL — but the exposed set is GDPR/KVKK-relevant PII with no masking or object-level gate.

**Rule violated:** Domain PII invariant + IDOR/object-level authz (layer-2-defect-catalog §Authz gaps).
**Proposed fix direction:** add object-level authz to `employee(id)` (self / supervisor-chain / HR-staff capability); consider field-level split of contactInfo/address behind an HR-staff capability with a masked directory projection for the broad role.
**Ripple set:** `apps/hr-service/src/hr/hr.resolver.ts`, `GetEmployeeQuery`/`GetEmployeesQuery` handlers.
**Expected closer:** hr-expert WRITER + multi-tenant-saas-expert.

#### DB-PEOPLE-MEDIUM-002 — AI cost tracking has no durable per-invocation ledger (`ai.conversation_turns` absent)

**Severity:** MEDIUM · **Layer:** 1 (AI domain — cost attribution) · **State:** OPEN · **Class:** MISSING-TABLE

The layer-1-ai SSoT specifies an immutable per-turn audit table `ai.conversation_turns` carrying `{tenantId, personaId, model, input_tokens, output_tokens, cache_hit, cost_usd, flagged_categories}`. No such entity/table exists in ai-service (only 4 live entities). Durable cost signal is limited to `agent_conversations.totalTokens` (`conversation.entity.ts:36-37`, a mutable aggregate `int` — no USD, no cache split, no per-turn immutability), while enforcement rides an **ephemeral** Redis counter (`token-budget.service.ts` — `ai:tokens:{tenant}:{YYYY-MM}`, TTL = month-end + 48h). The agent-runner tracks `cacheRead`/`cacheCreation` (`agent-runner.service.ts:323-326`) but budgets only `input+output` (`:329,443`), so cache-creation cost is unbilled. BYOK cost caps + finance reconciliation + safety forensics therefore have no durable per-invocation record. Note the scope's expected "cost tracking" entity is genuinely absent.

**Rule violated:** Domain invariant "AI cost/audit rows are load-bearing"; layer-1-ai audit-trail contract.
**Proposed fix direction:** add the `ai.conversation_turns` immutable per-turn ledger (cost_usd, cache split, flagged_categories) written in the provider-neutral runner; keep Redis as the fast enforcement cache, DB as the durable SSoT.
**Ripple set:** `apps/ai-service/src/agent/agent-runner.service.ts`, `apps/ai-service/src/cost/**`, a new migration + entity.
**Expected closer:** ai-safety-auditor + data-expert WRITER.

#### DB-PEOPLE-MEDIUM-003 — `tool_execution_audit` writes are fire-and-swallow (fail-open audit durability)

**Severity:** MEDIUM (candidate HIGH for actuation tools) · **Layer:** 2 (audit durability) · **State:** OPEN · **Class:** WRITE-ONLY (best-effort)

`ToolExecutorService.executeTool` correctly calls the audit on EVERY branch — unknown tool, permission-denied, actuation blocked/pending, and success (`tool-executor.service.ts:44,64,90,102`) — provider-agnostically. However `AuditService.logToolExecution` wraps the `save` in a `try/catch` that logs and **swallows** any storage failure (`audit.service.ts:38-43`); the executor comment concedes it "does not by itself GUARANTEE durability; a hard durability guarantee (outbox/transaction) is tracked separately" (`tool-executor.service.ts:97-101`). Under a DB/grant error on the cross-tenant `ai.tool_execution_audit` table (precisely the failure mode that broke messaging partitions on 2026-07-07), a tool — including autonomous actuation (dosing) — executes with NO durable audit row, silently. The domain invariant makes these rows load-bearing for safety review.

**Rule violated:** Domain invariant "AI cost/audit rows are load-bearing"; layer-2-defect-catalog §Empty/swallowing catch (fail-open).
**Proposed fix direction:** write the audit row in the same transaction/outbox as the tool effect (Tier-1/2), or at minimum surface a hard-fail + metric on audit-write failure for actuation-class tools rather than swallowing.
**Ripple set:** `apps/ai-service/src/audit/audit.service.ts`, `tools/core/tool-executor.service.ts`.
**Expected closer:** ai-safety-auditor + data-expert WRITER.

#### DB-PEOPLE-MEDIUM-004 — AI conversation history is double-modeled across `messaging.messages` and `ai.agent_conversations` with no declared single owner

**Severity:** MEDIUM · **Layer:** 2 (duplicate structure) · **State:** OPEN · **Class:** DUPLICATE-STRUCTURE

AI chat history is persisted in two shapes: (a) `messaging.messages` rows (`isAiGenerated=true`, AI-persona channel) — relational, per-turn, with receipts/reactions; (b) `ai.agent_conversations.messages` (`conversation.entity.ts:25-31`) — a jsonb blob of the whole conversation used for agent-runner context. The GDPR erasure path must scrub BOTH (`gdpr.service.ts:329-336` anonymises `messaging.messages` + `:399-410` directly UPDATEs `ai.agent_conversations` + emits `GdprAnonymizeRequested`), confirming the overlap. No ADR declares which store is the SSoT for AI conversation content, so the two can diverge (e.g., an in-channel edit not reflected in the blob).

**Rule violated:** layer-2-defect-catalog §Duplication; methodology `DUPLICATE-STRUCTURE`.
**Proposed fix direction:** declare a single physical owner for AI conversation content (likely `messaging.messages` for in-channel chat; scope `agent_conversations` to runner context/summary only), documented in an ADR; align the GDPR cascade to the owner.
**Ripple set:** `apps/ai-service/src/conversation/**`, `apps/messaging-service/src/ai/**`, `gdpr.service.ts`.
**Expected closer:** ai-safety-auditor + messaging-expert (arbiter for the ownership call).

## Cross-domain dependencies flagged

- DB-PEOPLE-HIGH-001: also invoke **frontend-expert** (codegen rewire) + **hr-expert** (which of 5 missing ops are real).
- DB-PEOPLE-MEDIUM-001: also **multi-tenant-saas-expert** (object-level authz) — MODULE_USER grant breadth is tenant-RBAC-dependent.
- DB-PEOPLE-MEDIUM-002/003: also **ai-safety-auditor** (load-bearing cost/audit invariants).
- DB-PEOPLE-MEDIUM-004 + Appendix B INC-MSG-1: cross-service coupling messaging→ai — route to **architectural-arbiter** for the ownership ruling.

## Verdict

**CONDITIONAL.** No CRITICAL. One HIGH (hr-module contract drift renders the payroll + performance UI non-functional against the gateway) and four MEDIUM. The messaging/AI compliance + safety invariants (legal hold, partition grants, BYOK masking, provider-agnostic cost/audit) are correctly implemented — a strong result. Conditions to clear: close DB-PEOPLE-HIGH-001 (or confirm hr-module is undeployed and track it) and the MEDIUM cost/audit-durability gaps.

## References

- Methodology: `.claude/agents/_shared/db-audit-methodology.md`; knowledge layers 1-core/nestjs/typeorm/react/ai, 2-patterns/defect-catalog, 3-adrs.
- ADR-011/012 (schema/drift), ADR-013 (messaging isolation); `MODULE_SCHEMAS` `libs/backend-common/src/database/schema-manager.service.ts:495-654`.
- Federation registry `infrastructure/apollo-router/subgraphs.json`; SDLs `dist/graphql/subgraphs/{hr,messaging}.graphql`.
- Prior: `docs/reviews/db-audit/db-audit-people-messaging/`, root `codegen.ts`, `docs/reviews/orphan-findings.md`.

---

## Appendix A — Provenance matrix

Convention: to stay scannable, homogeneous audit columns (`createdAt/updatedAt/createdBy/updatedBy/version/isDeleted/deletedAt/deletedBy`) collapse to one `audit-cols` row per table (writer `SYSTEM`/`FE-FORM`, read `GRAPHQL`, class `OK`). Deep file:line evidence attaches only to non-`OK` rows. ADR-011 placement verified per table. Writer/read/fe/class vocabulary per methodology.

### HR service (schema-per-tenant `hr`)

#### employees (per-tenant)
| column(s) | writer | read | fe | class |
|---|---|---|---|---|
| id, tenantId, employeeNumber, status, employmentType, department, position, hireDate, terminationDate, currency, farmId, supervisorId, userId, personnelCategory, assignedWorkAreas, seaWorthy, positionId, departmentHrId, currentRotationId, timezone, isFarmWorker, laborCategory, firstName, lastName, email, certifications, skills | FE-FORM | GRAPHQL | hr-module, AQUAMOBIL | OK |
| contactInfo (jsonb), address (jsonb) | FE-FORM | GRAPHQL | hr-module/EmployeeDetail | over-exposed (DB-PEOPLE-MEDIUM-001) |
| nationalId, bankDetails | FE-FORM | NONE (`@HideField`, AES-GCM) | NONE | OK (encrypted, hidden) |
| dateOfBirth, baseSalary, emergencyInfo | FE-FORM | NONE (`@HideField`) | NONE | OK (hidden; secure resolver only) |
| audit-cols, departmentHr(rel), payrolls(rel `@HideField`) | mixed | GRAPHQL/NONE | hr-module | OK |

#### payrolls (per-tenant)
| column(s) | writer | read | fe | class |
|---|---|---|---|---|
| id, tenantId, employeeId, payrollNumber, payPeriodType, payPeriodStart/End, paymentDate, status, currency, approvedBy/At, notes, paymentReference, workHours(jsonb) | FE-FORM/SYSTEM | GRAPHQL (MANAGER/ADMIN) | hr-module/Payroll | OK (role-gated) |
| earningsBaseSalary…earningsGrossPay, deductionsTax…deductionsTotal, netPay | FE-FORM/SYSTEM | GRAPHQL (MANAGER/ADMIN) | hr-module/Payroll | OK (role-gated) |
| earnings, deductions (getters) | — | NONE (no `@Field`) | hr-module fragment selects them | MISSING-FIELD (DB-PEOPLE-HIGH-001) |
| audit-cols | SYSTEM | GRAPHQL | hr-module | OK |

#### payroll_audit (cross-tenant `schema:'hr'`, INSERT-ONLY)
id, tenantId, payrollId, employeeId, action, calculationInputs/Outputs(jsonb), grossPay, netPay, currency, performedBy, notes, ipAddress, createdAt — writer `SYSTEM`, read `BE-INTERNAL` (no resolver despite `@ObjectType` — see INC-HR-2), fe NONE, class `BE-ONLY` (labor-law audit HR-HIGH-006).

#### hr_outbox (cross-tenant `schema:'hr'`)
OutboxEntityBase cols — writer `SYSTEM`, read `BE-INTERNAL`, fe NONE, class OK.

#### hr_mobile_command_receipts (per-tenant, idempotency)
id, tenantId, clientCommandId, payloadHash, operationType, deviceId, clientCreatedAt, status, responseType/Id/Payload(jsonb), createdAt/updatedAt — writer `SYSTEM` (mobile dedup), read `BE-INTERNAL`, fe NONE (backs AQUAMOBIL replay), class OK.

#### departments_hr, leave_types, leave_balances, leave_requests, shifts, schedules, schedule_entries, scheduling_settings, attendance_records, weekly_plans, weekly_plan_entries, holidays, training_courses, training_sessions, training_enrollments, certification_types, employee_certifications, goals, performance_reviews, employee_kpis, work_areas, work_rotations, safety_training_records, hr_finance_categories, hr_finance_entries, hr_payroll_cost_settings (all per-tenant)
All columns: writer `FE-FORM` (+`SYSTEM` for derived counters/audit-cols; +`EVENT` for `hr_payroll_cost_settings.defaultCurrency` via `FinanceSettingsUpdated`), read `GRAPHQL`, fe hr-module (+`AQUAMOBIL` for attendance_records/leave_requests/goals via `my*` self-service + clock-in/out). Class `OK`. Non-OK / notable:
- `goals.keyResults`/`goals.milestones`, `performance_reviews.competencyRatings` (jsonb object lists): persisted OK; FE selection invalid → DB-PEOPLE-HIGH-001.
- Non-persisted `@Field` projections (`training_courses.certificationType/prerequisiteCourses/enrollmentCount/completionRate`, `training_sessions.courseId/courseName/enrolledCount/availableSlots`, `certification_types.prerequisites`, `goals.daysOverdue`, `attendance_records.totalBreakMinutes`, `employee_certifications.daysUntilExpiry`, `leave_balances.currentBalance/availableBalance`): writer `SYSTEM` (query-handler), read `GRAPHQL`, class OK (BE-derived, surfaced).

### Messaging service (schema-per-tenant `messaging`)

Schema placement verified: cross-tenant `messaging_outbox`, `embeddings_metadata`, `message_send_idempotency` DECLARE `schema:'messaging'` ✓; all per-tenant tables (incl. `compliance_audit_log`, `retention_policies`, `legal_holds` — the ADR-011 inversion) correctly OMIT `schema:` ✓. All per-tenant tables present in `MODULE_SCHEMAS.tables` (`schema-manager.service.ts:635-654`) ✓.

#### messages (per-tenant, RANGE-partitioned by createdAt; composite PK (id,createdAt))
| column(s) | writer | read | fe | class |
|---|---|---|---|---|
| id, tenantId, channelId, senderId, content, contentType, parentId, forwardedFrom, isDeleted, createdAt, editedAt, updatedBy, isAiGenerated | FE-FORM (send/edit), EVENT (AI reply) | GRAPHQL | messaging-module, AQUAMOBIL | OK |
| idempotencyKey | SYSTEM | BE-INTERNAL (dedup) | NONE | OK |
| metadata (jsonb, no `@Field`) | FE-FORM | BE-INTERNAL | NONE | BE-ONLY |
| embedding (`vector(384)`, NOT in entity) | SYSTEM (ai-service via NATS) | BE-INTERNAL (similarity search `search-similar-messages.handler.ts:124`) | NONE | BE-ONLY / entity-invisible (INC-MSG-2) |

#### channels, channel_members, message_attachments, message_receipts, message_receipt_ledger, message_reactions, pinned_messages (per-tenant)
All columns: writer `FE-FORM`/`SYSTEM`, read `GRAPHQL` (attachments expose presigned `downloadUrl`/`thumbnailUrl` only via `@ResolveField` — Tier-1 MSG-CRITICAL-052), fe messaging-module + AQUAMOBIL. Class OK. `channel.aiServiceUrl` = deprecated always-null field (DB column dropped migration 1802000000000) — UI-WITHOUT-DB by design (INC-MSG-3). `message_receipt_ledger` = per-tenant SSoT for receipt identity (partition-free unique). `message_send_idempotency` (cross-tenant infra): writer `SYSTEM`, read `BE-INTERNAL`, class OK.

#### legal_holds, retention_policies, compliance_audit_log (per-tenant)
All columns: writer `FE-FORM` (admin-gated mutations `toggleLegalHold`/`setRetentionPolicy`) + `SYSTEM` (retention/GDPR audit rows), read `GRAPHQL` (`@Roles(TENANT_ADMIN)` on ComplianceResolver, enforced by global `RolesGuard`), fe messaging admin surface. Class OK. `compliance_audit_log` composite PK (id,createdAt) + migration-installed UPDATE/DELETE-prevention trigger + `@ObjectType` exposed read-only. `legal_holds` carries dual-approver release columns (`releasedByApprover`, CHECK `no_self_approval`) — correctly modeled.

#### knowledge_entries, message_analysis, message_entity_references, user_ai_consents (per-tenant AI-bridge)
writer `SYSTEM` (knowledge-extraction / analysis pipeline) / `FE-FORM` (`user_ai_consents` via `updateUserAiConsent`), read `GRAPHQL`/`BE-INTERNAL`, fe messaging AI panels. Class OK. `knowledge_entries.sourceMessageId` = ON DELETE SET NULL (survives message purge; GDPR path explicitly deletes by sourceMessageId — `gdpr.service.ts:362-370`).

#### messaging_outbox, embeddings_metadata (cross-tenant `schema:'messaging'`)
writer `SYSTEM`, read `BE-INTERNAL`, fe NONE, class OK. `messaging_outbox` overrides base BIGINT PK with UUID for NATS Msg-Id dedup.

### AI service (schema-per-tenant `ai`)

#### agent_conversations (per-tenant)
| column(s) | writer | read | fe | class |
|---|---|---|---|---|
| id, tenantId, userId, persona, title, isActive, createdAt, updatedAt | SYSTEM (chat responder) | BE-INTERNAL + socket.io/NATS chat | AQUAMOBIL AiChatPage | OK |
| messages (jsonb conversation) | SYSTEM | BE-INTERNAL (runner context) | AQUAMOBIL | DUPLICATE-STRUCTURE (DB-PEOPLE-MEDIUM-004) |
| totalTokens | SYSTEM (runner) | BE-INTERNAL (cost) | NONE | WRITE-ONLY-ish (only durable cost signal; DB-PEOPLE-MEDIUM-002) |

#### tenant_agent_configs (per-tenant)
| column(s) | writer | read | fe | class |
|---|---|---|---|---|
| provider, chatModel, baseProfileId, additionalToolNames, blockedToolNames, actuationPolicy, customSystemPrompt, applicableRoles, isEnabled, proactiveMonitoringEnabled, autonomousActionsEnabled, autonomousSafetyLimits, monthlyTokenBudget, hourlyRequestLimit, mcpEnabled, mcpAllowedPersonas | FE-FORM (`updateAiProviderSettings`, cap `ai_settings:manage`) | GRAPHQL (masked `AiSettings` DTO) | tenant-admin AI settings | OK |
| anthropicApiKey, openaiApiKey (AES-256-GCM) | FE-FORM (validated live) | NONE raw — GRAPHQL exposes last-4 hint only (`agent-config.resolver.ts:192-193,235-239`) | tenant-admin (hint) | OK (correctly masked) |

#### tool_execution_audit (cross-tenant `schema:'ai'`)
id, tenantId, userId, toolName, persona, input(jsonb), success, output(jsonb), errorMessage, durationMs, correlationId, conversationId, executedAt — writer `SYSTEM` (every tool-executor branch; provider-agnostic), read `BE-INTERNAL` (`getRecentExecutions`, operator/safety analytics), fe NONE, class `BE-ONLY` but durability best-effort (DB-PEOPLE-MEDIUM-003).

#### ai_outbox (cross-tenant `schema:'ai'`)
OutboxEntityBase — writer `SYSTEM`, read `BE-INTERNAL`, fe NONE, class OK.

### Frontend surfaces
- **hr-module** (federated remote): operations hand-written, NOT codegen-validated → DB-PEOPLE-HIGH-001. Employee list/detail fragments split PII correctly (`EMPLOYEE_LIST_FRAGMENT` omits contactInfo/address; `EMPLOYEE_FULL_FRAGMENT` includes them).
- **messaging-module** (formerly a 4-file scaffold, now ~11 files with pages/hooks/socket): `graphql/messaging-operations.ts` operations are schema-valid against the messaging subgraph (User display fields resolve via the federated auth subgraph); deliberately omit deprecated `aiServiceUrl`. Clean.
- **aquamobil** (LIVE messaging + AI chat + attendance): `graphql/messaging-operations.ts` is S1-CODEGEN — every op is a `TypedDocumentNode` against `@/generated/graphql`, so operation drift is a compile error. Selects deprecated `aiServiceUrl` (valid, always-null). Clean + gated.

## Appendix B — Incidental findings (operator directive — ALL deficiencies noticed, incl. out-of-partition)

- **[INC-HR-1] Stale MODULE_SCHEMAS comment (LOW, doc drift).** `schema-manager.service.ts:500-503` says "hr-service does not yet wire a migration runner (see app.module.ts:300)", but `apps/hr-service/src/app.module.ts:119,346-350` DOES register `HrMigrationRunnerService` (`createSchemaVersionGate('hr')`) + `SchemaDriftModule.forRoot({serviceName:'hr'})`. Stale comment misleads on the migration path.
- **[INC-HR-2] `PayrollAudit` `@ObjectType()` is inert (LOW).** `payroll-audit.entity.ts:34` declares `@ObjectType` + `@Field` on every column, but no resolver exposes it and it is absent from `hr.graphql`. The GraphQL decoration is dead; `@Field(() => String)` on the `jsonb` `calculationInputs/Outputs` would serialize objects as strings if ever wired — latent shape bug. Wire a role-gated audit query or drop the decorators.
- **[INC-HR-3] Dual department model (LOW, duplication).** `Employee.department` (enum, `employee.entity.ts:244`) coexists with `departmentHrId`→`departments_hr`. The FE `DEPARTMENT_FRAGMENT` comment (`fragments.ts:99`) even claims "Department is an enum in the backend (not a separate entity)" while `departments_hr` IS an entity. Declare a single owner.
- **[INC-HR-4] Fail-silent timezone helpers (LOW).** `attendance-record.entity.ts:28,43,59,71` swallow all errors in `convertLocalToUtc/convertUtcToLocal/getTimezoneOffset/isValidTimezone`, silently mis-computing worked-minutes (payroll-adjacent) on a malformed IANA tz instead of surfacing.
- **[INC-HR-5] Inline `require('crypto')` in entity hooks (LOW, hygiene).** `leave-request.entity.ts:252`, `attendance-record.entity.ts:341`, `employee-certification.entity.ts:212` — correct secure randomBytes, but CommonJS `require` inside `@BeforeInsert` on an ESM/TS entity; hoist to a top import.
- **[INC-HR-6] HR lacks FORCE RLS (LOW) — pre-existing MT-HIGH-003.** HR relies on search_path alone (known 2/7 RLS adoption: farm, messaging only). Recorded for completeness.
- **[INC-MSG-1] Cross-service direct DB write in GDPR erasure (MEDIUM, bounded-context violation).** `gdpr.service.ts:399-416` has messaging-service directly `UPDATE agent_conversations` (owned by ai-service) inside its own transaction, wrapped in a broad `catch {}` that swallows ALL errors (incl. a genuine ai-service schema drift) and only warns — so the direct AI-erasure arm can silently no-op, relying solely on the `GdprAnonymizeRequested` event. Belt-and-suspenders that breaks ownership isolation; prefer event-only cascade.
- **[INC-MSG-2] `messages.embedding` durable column invisible to the entity (LOW).** `messages` has a `vector(384)` pgvector column (raw-SQL managed; TypeORM cannot map it) deliberately omitted from `Message` (`ai-privacy.service.ts:224`). Legitimate, but it is a durable column with no entity representation — SchemaDriftValidator must carry an explicit ignore, else it flags at cold start. Confirm the ignore is present.
- **[INC-MSG-3] `Channel.aiServiceUrl` deprecated always-null field (LOW, tracked).** Write path + DB column removed (migration 1802000000000, MSG-HIGH-060 exfil fix); GraphQL field retained as deprecated always-null for the mobile client until its codegen regenerates. Expand-contract in progress — drop once no client selects it.
- **[INC-MSG-4] Retention cron swallows sweep-wide failure (LOW).** `retention-policy.service.ts:271-274` logs `error` on a total sweep failure but does not re-throw or emit an alert metric — acceptable to keep the scheduler alive, but a silently-failing retention sweep has no alarm signal.
- **[INC-AI-1] Token budget cache-creation cost unbilled (LOW).** `agent-runner.service.ts:323-329,443` tracks `cacheCreation` tokens but budgets only `input+output`, so cache-write cost (a real BYOK charge) is not counted toward `monthlyTokenBudget`.

---
*Audit complete: HR (31) + messaging (18) + AI (4) entities traced; FE hr-module / messaging-module / aquamobil mapped.*
