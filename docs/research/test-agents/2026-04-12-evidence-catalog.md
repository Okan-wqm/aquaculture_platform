# Test Agents Evidence Catalog

**Date:** 2026-04-12
**Purpose:** shared repo-specific discovery starting points for `.claude/test-agents/`

This file is not a replacement for specialist reasoning. It is a shared starting map so specialist auditors do not rediscover the same repo structure from scratch on every cycle.

## 1. UI Surface Discovery

Primary page and surface locations:

- `web/modules/*/src/pages/**`
- `web/apps/aquamobil/src/pages/**`
- `web/shared-ui/**`
- `web/modules/*/src/components/**`

Useful starting searches:

```bash
rg --files web/modules web/apps | rg '(Page|Modal|Form|Table|List|Chart|Widget|Upload|Import|Export|Attachment|Dashboard)'
rg -n 'onClick|onPress|handleSubmit|handleSave|handleDelete|handleExport|handleImport|useMutation|useQuery' web/modules web/apps
rg -n 'graphqlClient.request|authenticatedFetch|fetch\\(' web/modules web/apps web/shared-ui
```

## 2. Write-Path Discovery

Common write-path evidence:

- frontend mutation hooks under `web/**/hooks/**`
- GraphQL mutations in frontend pages and services
- NestJS controllers/resolvers under `apps/**`
- command/handler/service layers under `apps/**`

Useful starting searches:

```bash
rg -n 'mutation|useMutation|handleSubmit|submit|save|create|update|delete|archive|restore|approve|retry' web/modules web/apps
rg -n '@Mutation|@Post|@Put|@Patch|@Delete|CommandHandler|execute\\(' apps
rg -n 'create\\(|update\\(|save\\(|remove\\(|softDelete\\(' apps
```

## 3. Read-Path Discovery

Common read-path evidence:

- query hooks and loaders in `web/**`
- REST/GraphQL query endpoints in `apps/**`
- serializers, query handlers, projections, and read services in `apps/**`

Useful starting searches:

```bash
rg -n 'useQuery|queryKey|loader|refetch|graphqlClient.request' web/modules web/apps
rg -n '@Query|@Get|QueryHandler|findOne|findAll|getById|list|search' apps
rg -n 'serialize|toResponse|toDto|projection|read model' apps libs platform
```

## 4. Access and Tenant Boundaries

Common access and tenant evidence:

- role/permission decorators and guards in `libs/backend-common/**`
- auth context and route guards in `web/**`
- impersonation and tenant-admin surfaces in `web/modules/admin-panel/**` and `web/modules/tenant-admin/**`

Useful starting searches:

```bash
rg -n '@Roles|@Public|CanActivate|RolesGuard|TenantGuard|accessType|permission|impersonat|feature flag' apps web libs
rg -n 'tenantId|tenant_id|X-Act-As-Tenant|search_path|tenant:' apps web libs platform
rg -n 'localStorage|indexedDB|idb-keyval|queryKey|invalidateQueries' web/apps/aquamobil web/modules web/shared-ui
```

## 5. Live, Sync, and Mobile Reconnect

Common live/sync evidence:

- polling hooks, refetch intervals, and query invalidation in `web/**`
- service-worker and offline queue logic in `web/apps/aquamobil/**`
- notification and activity feeds in web and mobile surfaces

Useful starting searches:

```bash
rg -n 'poll|refetchInterval|setInterval|EventSource|SSE|subscribe|postMessage|service worker|sync|offline queue' web
rg -n 'Notification|notification|activity feed|badge|unread|push' web apps
rg -n 'invalidateQueries|setQueryData|refetch|resume|reconnect' web
```

## 6. Tables, Charts, Files

Common evidence:

- grid surfaces in `web/**`
- chart widgets and dashboards in `web/**`
- export/import/upload/download flows in `web/**` and `apps/**`

Useful starting searches:

```bash
rg --files web | rg '(Table|List|Grid|Chart|Widget|Kpi|Dashboard|Upload|Import|Export|Attachment|Media)'
rg -n 'csv|xlsx|pdf|download|export|upload|attachment|multipart' web apps
rg -n 'sort|filter|pagination|pageSize|search' web/modules web/apps
```

## 7. Edge, Industrial, and SCADA Surfaces

Common evidence:

- Rust gateway code in `sens-api-gateway/src/**`
- gateway docs in `sens-api-gateway/docs/**`
- sensor and PLC-facing product surfaces in `web/modules/sensor-module/**`
- related edge and VFD code in `apps/sensor-service/**`

Useful starting searches:

```bash
rg --files sens-api-gateway/src sens-api-gateway/docs | rg '(modbus|offline_queue|safe_state|security|scada|opcua|s7comm|ethernet_ip|ads|codesys)'
rg -n 'command|write|ack|safe_state|offline_queue|tenant|device_id|retry|replay' sens-api-gateway/src apps/sensor-service/src
rg -n 'plc|scada|gateway|installer|fleet|emergency|setpoint' web/modules/sensor-module/src apps/sensor-service/src
```

## 8. Billing and Financial Reconciliation

Common evidence:

- billing write and read models in `apps/billing-service/src/**`
- admin billing management in `apps/admin-api-service/src/billing/**`
- Stripe ingress in `apps/billing-service/src/billing/controllers/**`

Useful starting searches:

```bash
rg --files apps/billing-service/src apps/admin-api-service/src web/modules | rg '(billing|invoice|payment|refund|subscription|meter|usage|stripe)'
rg -n 'stripe|payment_intent|invoice|refund|subscription|meter|usage|idempot' apps/billing-service/src apps/admin-api-service/src
rg -n 'paid|overdue|void|refunded|finalize|record payment|usage breakdown' apps/billing-service/src apps/admin-api-service/src web/modules
```

## 9. AI Tool Execution and Safety

Common evidence:

- execution and registry code in `apps/ai-service/src/agent/**` and `apps/ai-service/src/tools/**`
- safety and SSRF protection in `apps/ai-service/src/safety/**`
- audit and budget controls in `apps/ai-service/src/audit/**` and `apps/ai-service/src/cost/**`

Useful starting searches:

```bash
rg --files apps/ai-service/src | rg '(agent-runner|tool-executor|tool-registry|tool-execution-audit|audit.service|ssrf-validator|ai-safety|token-budget|rate-limit|tenant-config)'
rg -n 'executeTool|tool|registry|schema|validate|ssrf|budget|rate limit|audit|tenant' apps/ai-service/src
rg -n 'TODO|audit|monthlyTokenBudget|allowedTools|tool_execution_audit' apps/ai-service/src
```

## 10. GDPR, Consent, and Audit-Trail Surfaces

Common evidence:

- shared GDPR infrastructure in `libs/backend-common/src/security/gdpr/**`
- shared audit infrastructure in `libs/backend-common/src/audit/**`
- auth and admin compliance flows in `apps/auth-service/**` and `apps/admin-api-service/src/security/**`
- user-facing consent surfaces in `web/shell/**`

Useful starting searches:

```bash
rg --files apps/auth-service/src apps/admin-api-service/src libs/backend-common/src web/shell/src web/modules/admin-panel/src | rg '(gdpr|consent|compliance|audit-trail|audit-log|privacy)'
rg -n 'consent|exportUserData|erase|delete|anonym|logoutAllDevices|audit' apps/auth-service/src apps/admin-api-service/src libs/backend-common/src web/shell/src
rg -n '@Audit|AuditLog|AuditedOperation|data request|withdraw' apps libs
```

## 11. Accessibility Foundations

Common evidence:

- shared accessibility helpers and modal primitives in `web/shared-ui/src/components/**`
- focus and modal-heavy product surfaces in `web/modules/**` and `web/shell/**`

Useful starting searches:

```bash
rg --files web/shared-ui/src/components web/modules web/shell/src web/apps/aquamobil/src | rg '(a11y/|FocusTrap|RouteAnnouncer|VisuallyHidden|Modal|Dialog|Consent|NotificationPanel)'
rg -n 'aria-|role=|aria-live|aria-modal|aria-expanded|aria-label|aria-describedby|aria-busy|tabIndex' web/shared-ui web/modules web/shell web/apps/aquamobil -g '*.tsx' -g '*.ts'
rg -n 'focus|FocusTrap|keyboard|onKeyDown|Escape|Enter|Space|sr-only|VisuallyHidden' web/shared-ui web/modules web/shell web/apps/aquamobil -g '*.tsx' -g '*.ts'
```

## 12. Webhook and Callback Ingress

Common evidence:

- webhook and callback controllers in `apps/**`
- trust utilities in `libs/backend-common/src/guards/**` and `libs/backend-common/src/utils/**`
- provider-specific ingress such as Stripe in billing-service

Useful starting searches:

```bash
rg --files apps libs sens-api-gateway | rg '(webhook|callback|service-identity|signature)'
rg -n 'webhook|callback|stripe-signature|X-Service-Signature|verifySignature|idempot|replay' apps libs sens-api-gateway -g '*.ts' -g '*.rs'
rg -n '@Controller\\(' apps -g '*.ts' | rg 'webhook|callback'
```

## 13. Current Roster Coverage Limits

The current `.claude/test-agents/` roster is strongest on:

- web and AquaMobil roundtrip truth
- form/action/read-back/list visibility
- role and tenant boundaries inside product surfaces
- tables, charts, files, and live/sync behavior
- accessibility-critical operability
- billing reconciliation and inbound webhook trust
- GDPR and compliance truth
- AI tool execution safety
- edge and industrial-control truth

The current roster now has dedicated specialists for:

- `sens-api-gateway/**` Rust edge and industrial protocol roundtrips
- billing reconciliation and Stripe webhook correctness
- AI tool execution operator truth
- GDPR/compliance roundtrip completeness
- accessibility/WCAG-adjacent operability review
- inbound webhook-ingress correctness as a primary domain

The current roster still does **not** have a dedicated specialist for:

- background job and outbox reliability as a first-class audit domain
- notification delivery and opt-out truth across channels
- session and JWT lifecycle as a standalone primary domain
- i18n, localization, and RTL completeness

Any audit claiming broad platform confidence must explicitly mark these remaining gaps or supplement the cycle with additional specialists.
