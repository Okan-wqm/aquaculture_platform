# AI tenant and site boundaries — multi-tenant-saas-expert, 2026-09-29

Raised in the 2026-09-29 adversarial review of the ai-service program plan (automatic tasks, tracking agents, AI configuration).
Four reviewers (alert-engine, AI safety, farm domain, architecture) attacked plan rev 2 against origin/main `dae95efb3`;
the main session re-verified the load-bearing claims in code. MT-HIGH-064 and MT-MEDIUM-065 come from the PR-T1 audit.
Each finding below names the plan PR that closes it. Findings marked "owner decision" need a product decision before any code.

## MT-HIGH-062 — AI tool tenant binding is a convention: tools hand-build request payloads with tenantId and replies are never checked against the caller's tenant

- **Severity:** HIGH. **Deadline:** 2026-10-15. **Closes in:** plan PR-T1.
- **Evidence:** `apps/ai-service/src/tools/farm/get-farm-tanks.tool.ts:60` — payload tenantId set by tool code.
- **Rule:** Tenant isolation must be structural (owner decision K10).

Owner: no AI agent may ever return another tenant's data. Closed by plan PR-T1.

## MT-MEDIUM-063 — ai-service applies no site authorization: caller capabilities carry no assignedSiteIds, so AI reads are not limited to the user's sites

- **Severity:** MEDIUM. **Deadline:** 2026-11-15. **Closes in:** plan PR-A1b.
- **Evidence:** `libs/backend-common/src/security/site-authorization.service.ts:67` — site scope exists but ai/messaging never receive assignedSiteIds.
- **Rule:** Site-level authorization.

Closed by plan PR-A1b (assignedSiteIds) and PR-C0a (tools apply resolveSiteScope).

## MT-HIGH-064 — The farm-service MCP insights bridge runs one child process under one static JWT for all tenants, so every tenant would receive the token tenant's risk and anomaly output

- **Severity:** HIGH. **Deadline:** 2026-10-15. **Closes in:** plan PR-T1.
- **Evidence:** `apps/farm-service/src/ai-insights/services/mcp-client.service.ts:120` — single MCP_JWT_TOKEN for the multi-tenant service.
- **Rule:** Tenant isolation must be structural (owner decision K10).

Dormant: MCP_ENABLED defaults to false and no compose file sets it; aquamobil already calls the queries. Found by the PR-T1 audit; closed fail-closed by plan PR-T1.

## MT-MEDIUM-065 — The MCP insights feature is single-tenant by construction; serving all tenants needs a per-tenant session design or removal of the feature

- **Severity:** MEDIUM. **Deadline:** 2026-11-30. **Closes in:** owner decision.
- **Evidence:** `apps/farm-service/src/ai-insights/services/ai-insights.service.ts:73` — caller tenant feeds only the cache key.
- **Rule:** Product decision required.

After PR-T1 the bridge refuses every tenant except the token tenant. Owner product decision (Okan): per-tenant MCP sessions or delete the feature.
