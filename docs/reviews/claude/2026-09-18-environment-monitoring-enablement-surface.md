# Environmental monitoring: the enablement surface and the honest closed state

**Date:** 2026-09-18 · **Reviewer:** claude (live diagnosis on the production droplet) · **Scope:** `apps/config-service`, `apps/farm-service/src/weather`, `web/modules/admin-panel`, `web/modules/farm-module/src/pages/environment`, `libs/event-contracts/src/config-runtime.ts`

**Trigger.** The tenant environment page for a sea-cage site (`/sites/environment/<siteId>`) showed three alerts — "Layer metadata could not be refreshed", "Current environmental data could not be loaded for this site", "Layer availability could not be loaded" — for a tenant admin. The operator recalled having saved the Copernicus (Sentinel Hub) credential earlier.

**Findings:** ADMIN-HIGH-135 (the company credential has no administrative surface — fixed here), ORPHAN-MEDIUM-827 (the closed rollout gate renders as three generic failures — fixed here).

## What the live system said

- farm-service logged, three times per page view for the tenant, `ServiceUnavailableException: Environmental monitoring is not enabled for this deployment` from `EnvironmentMonitoringGate.assertEnabled`.
- The live `aqua-farm` container carries `FARM_ENVIRONMENT_MONITORING_ENABLED=false`; the droplet Compose file defaults it to `false` and the deploy checkout's `.env` does not set it. `MET_NORWAY_APPLICATION_NAME` and `MET_NORWAY_CONTACT` are empty strings.
- config-service holds no row, no soft-deleted row and no history for `marine.cdse.credentials`. No tenant schema holds a `sentinel_hub_settings` row; the `farm` source schema holds none either. The farm audit ledger has no Sentinel entry for the tenant. The credential the operator remembers never existed in this database — an independent three-way comparison (droplet, dump, restored copy) reached the same conclusion.
- PR #1044 (`a297b45dd4`, 2026-08-01, BREAKING CHANGE) removed the per-tenant `saveSentinelHubSettings` mutation and `SentinelHubSettingsPage` and moved the credential to one company row in config-service, writable only by a tenantless `SUPER_ADMIN`.

## ADMIN-HIGH-135 — the company Copernicus credential has no administrative surface

**Defect.** After #1044 the only write path for the company CDSE credential was a hand-written `setConfiguration` GraphQL call, documented in `docs/runbooks/monitoring/farm-environment-monitoring.md` step 2 with the service, key, environment, secret flag and the JSON bundle shape for the operator to type. The admin panel's System Settings page writes only `service=platform` keys (`usePlatformConfiguration.ts`), so it could not offer the write without copying the key and bundle shape into the browser — which is why nobody built it. Result: a shipped product feature whose enablement depended on an operator reproducing a backend contract by hand.

**Why the fix is a dedicated surface, not a generic form.** The credential is one secret bundle under a service/key pair that only the backend contract (`MARINE_PROVIDER_CREDENTIAL_SERVICE`, `MARINE_PROVIDER_CREDENTIAL_KEYS.CDSE`, `serializeMarineProviderCdseCredentialBundle`) knows. A generic key/value form would have every client re-encode that knowledge. Instead config-service gains `MarineProviderCredentialResolver`:

- `marineProviderCredentialStatus(provider)` — reports `configured`, `version`, `updatedAt`; never the value, never the author.
- `setMarineProviderCdseCredential(input)` — takes the credential's fields as typed GraphQL arguments, assembles the bundle with the contract serializer, and writes it through the existing `UpsertConfigurationCommand`, so the handler's write policy (secret, `ALL` environment, complete bundle, system tenant) still decides. The storage key never leaves the backend.
- Authorization is the tenantless-SUPER_ADMIN rule the generic surface already applied to restricted provider credentials, now defined once in `configuration/graphql-principal.ts` and used by both resolvers, so the two cannot drift.
- The GraphQL `MarineProviderCredentialProvider` enum is pinned to the contract's provider set with `satisfies`; the input's length ceilings come from the contract's own `MARINE_PROVIDER_CDSE_FIELD_MAX_LENGTH` table (extracted from the parser's inline literals), so the surface cannot accept a value the trust boundary would reject.

The admin panel gains a **Providers** tab on System Settings (`components/settings/ProviderCredentialsTab.tsx`, `hooks/useMarineProviderCredential.ts`, `graphql/marine-provider-credential-operations.ts`) on the sanctioned data layer (`useAdminQuery` / `useAdminMutation` + `adminKeys`). Inputs are write-only and clear after a save; the tab shows stored/not-stored, revision and last change. The runbook's step 2 now points at the tab, and names the mutation as the only supported scripted path.

**Pins.** `marine-provider-credential.resolver.spec.ts` (refusals never touch the bus; the stored value is byte-parsable by the farm runtime's parser; tombstoned rows read as not configured; invalid fields are a `BadRequestException` before any write); `graphql-schema-build.spec.ts` builds the new surface (the nullable `Int | null` / `Date | null` reflection shape that gate exists for); `ProviderCredentialsTab.spec.tsx` (exact variables crossing the wire, form clearing, refused-write handling). `scripts/ci/validate-graphql-operations.mjs` validates the new operations against the composed supergraph on every PR.

**Owner:** claude. **Status:** RESOLVED by this PR.

## ORPHAN-MEDIUM-827 — the closed rollout gate renders as three generic failures

**Defect.** Every environment read calls `assertEnabled()` and answers a closed gate with a 503 carrying `code: ENVIRONMENT_MONITORING_DISABLED`. `EnvironmentPage.tsx` classified each refused read as a generic failure and rendered three "could not be loaded / refreshed" alerts — indistinguishable from a provider outage — and farm-service logged three exceptions per page view. Nothing the tenant does changes a closed gate; the page implied otherwise.

**Why the fix is a query, not error-code sniffing.** The production gateway's `formatError` keeps only `extensions.code`, and Nest's mapping of an `HttpException` thrown inside a federated resolver to that code is not a contract any client should build on. `environmentMonitoringStatus { enabled }` makes the gate a value: the one environment read that does not assert the gate, carrying no tenant data and needing no site scope. The page reads it first; while it is closed the page renders one `role="status"` panel stating that monitoring is not enabled for this deployment and issues no site reads; a refetch failure keeps the last-known answer, the same last-known-good rule the site list and layer catalog follow. The new field joins `ENVIRONMENT_READ_OPERATION_FIELD_LIMITS` so gateway and subgraph fence it identically.

**Pins.** `environment-resolver-gate.contract.spec.ts` (the status read reports the gate without asserting it; every other read refuses a closed gate before touching the read service; the resolver exposes nothing outside those two sets — a new read that forgets `assertEnabled` fails it); `EnvironmentPage.spec.tsx` (disabled state with no alerts and no site reads; unreadable gate reported without guessing; last-known gate kept on refetch failure).

**Owner:** claude. **Status:** RESOLVED by this PR.

## What this PR does not do

- It does not enable monitoring. Enablement is the runbook's steps 2–5 with the company's own CDSE credential and MET Norway identity, followed by `FARM_ENVIRONMENT_MONITORING_ENABLED=true` on the droplet. Those values belong to the operator.
- It does not move `MET_NORWAY_APPLICATION_NAME` / `MET_NORWAY_CONTACT` into config-service; they remain deployment environment as designed.
