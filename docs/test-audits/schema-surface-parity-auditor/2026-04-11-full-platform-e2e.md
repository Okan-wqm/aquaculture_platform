# Schema Surface Parity Auditor: `2026-04-11-full-platform-e2e`

Scope checked: `web/**`, `apps/**`, `libs/**`, `platform/**`, and `database/**` where needed to trace schema-to-surface mappings.

## Findings

### HIGH-001: Tenant AI persona controls are a local facade, not the real durable config model
`MessagingAiPersonasPage` renders a hardcoded `DEFAULT_PERSONAS` array and flips `enabledForAll` in local React state only. The page explicitly leaves persistence as `// TODO: Persist toggle via admin API mutation`, and the custom persona form is marked future-only. That means the visible persona governance UI is not writing to `tenant_agent_configs`, and none of the durable fields in `TenantAgentConfig` - `baseProfileId`, `additionalToolNames`, `blockedToolNames`, `actuationPolicy`, `customSystemPrompt`, `applicableRoles`, `autonomousActionsEnabled`, `autonomousSafetyLimits`, `monthlyTokenBudget`, `hourlyRequestLimit`, `mcpEnabled`, `mcpAllowedPersonas` - are actually editable from the product surface.

Root cause:
- The admin page is a static mock built from hardcoded defaults, not a bound CRUD view over the entity.
- No API mutation or backend read path connects the page to the durable tenant-agent config schema.
- The page therefore gives operators a false sense that persona policy changes are saved when they are not.

Evidence:
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx:39`](/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx#L39)
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx:189`](/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx#L189)
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx:220`](/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx#L220)
- [`/var/aqua-saas/apps/ai-service/src/tenant-config/agent-config.entity.ts:13`](/var/aqua-saas/apps/ai-service/src/tenant-config/agent-config.entity.ts#L13)

Cross-domain dependency:
- `form-write-auditor`
- `contract-parity-auditor`
- `access-boundary-auditor`

### HIGH-002: Config-service persists a rich configuration/history model that the product never surfaces
`ConfigurationResolver` exposes a full GraphQL CRUD and history API over `Configuration` and `ConfigurationHistory`, but the web tier never binds to it. The only active admin settings surface is `SystemSettingsPage`, which fetches and saves a separate REST-backed `settingsApi` subset (`/settings/config/email`, `/settings/config/security`, `/settings/config/billing`, `/settings/config/rate-limits`, `/settings/system/info`). The admin panel route table has no page for `configuration`, `configurationById`, or `configurationHistory`, so the durable config model's typed fields, history, tags, validation rules, and per-tenant service keys are not inspectable or editable in-product.

Root cause:
- The platform split configuration into two disconnected models: config-service GraphQL on one side and admin-panel REST settings on the other.
- The web app only wires the REST facade, leaving the config-service resolver and its history read model without a product-facing entry point.
- Because there is no UI around `configurationHistory`, operators cannot verify roundtrip changes or review who changed what after the fact.

Evidence:
- [`/var/aqua-saas/apps/config-service/src/configuration/configuration.resolver.ts:106`](/var/aqua-saas/apps/config-service/src/configuration/configuration.resolver.ts#L106)
- [`/var/aqua-saas/apps/config-service/src/configuration/configuration.resolver.ts:151`](/var/aqua-saas/apps/config-service/src/configuration/configuration.resolver.ts#L151)
- [`/var/aqua-saas/apps/config-service/src/configuration/entities/configuration.entity.ts:57`](/var/aqua-saas/apps/config-service/src/configuration/entities/configuration.entity.ts#L57)
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/SystemSettingsPage.tsx:501`](/var/aqua-saas/web/modules/admin-panel/src/pages/SystemSettingsPage.tsx#L501)
- [`/var/aqua-saas/web/modules/admin-panel/src/services/api/settings.ts:37`](/var/aqua-saas/web/modules/admin-panel/src/services/api/settings.ts#L37)
- [`/var/aqua-saas/web/modules/admin-panel/src/Module.tsx:155`](/var/aqua-saas/web/modules/admin-panel/src/Module.tsx#L155)

Cross-domain dependency:
- `data-readback-auditor`
- `contract-parity-auditor`
- `form-write-auditor`

### MEDIUM-003: AI tool execution audit rows exist, but the admin UI cannot inspect them by tool, persona, or conversation
`ToolExecutionAudit` stores operationally meaningful records - tenant, user, tool name, persona, input/output, success, error, duration, correlation ID, and conversation ID - and `AuditService.getRecentExecutions()` can fetch them by tenant. The current admin-side audit surface, however, is the generic `AuditLogPage`, whose filters are limited to action, severity, entity type, tenant, and date range. There is no product page or audit drill-down for tool execution runs, so AI/tool-run failures remain invisible to operators even though the data is durably persisted.

Root cause:
- The AI service records tool executions into a dedicated audit table, but no frontend route consumes that table.
- The general audit page is scoped to system audit-log semantics, not tool-run telemetry.
- Because the tool-run audit data lacks a surfaced read model, operators cannot tie tool behavior back to persona, conversation, or correlation ID.

Evidence:
- [`/var/aqua-saas/apps/ai-service/src/audit/tool-execution-audit.entity.ts:9`](/var/aqua-saas/apps/ai-service/src/audit/tool-execution-audit.entity.ts#L9)
- [`/var/aqua-saas/apps/ai-service/src/audit/audit.service.ts:16`](/var/aqua-saas/apps/ai-service/src/audit/audit.service.ts#L16)
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/AuditLogPage.tsx:20`](/var/aqua-saas/web/modules/admin-panel/src/pages/AuditLogPage.tsx#L20)
- [`/var/aqua-saas/web/modules/admin-panel/src/pages/AuditLogPage.tsx:44`](/var/aqua-saas/web/modules/admin-panel/src/pages/AuditLogPage.tsx#L44)

Cross-domain dependency:
- `data-readback-auditor`
- `contract-parity-auditor`

## Result

Confirmed: 2 HIGH and 1 MEDIUM schema-surface parity gaps in this pass. The largest break is the split between mock persona settings and the real tenant-agent config schema; the second is the complete absence of a product-facing configuration-history surface for config-service.
