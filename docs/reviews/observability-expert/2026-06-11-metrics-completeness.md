# Metrics completeness + catalog scrape-surface SSoT (2026-06-11)

## OBS-HIGH-001 — 10 of 15 NestJS backends had NO Prometheus scrape surface; the catalog knew nothing about metrics ports and probed observability-service on a dead port

**Severity:** HIGH · **Owner:** observability-expert · **Cycle:** 2026-06-11-s1-remediation

### Observation (verified firsthand, with plan corrections)

The Wave B1 brief said "6 of ~15 services register a Prometheus metrics
module". Firsthand sweep (`@Controller('metrics')` across `apps/*/src`)
found only **5** real scrape endpoints:

| Service | Scrape surface (pre-fix) |
|---|---|
| gateway-api | YES — bespoke `GatewayMetricsController` (own `@Public()`) |
| auth-service | YES — bespoke `AuthMetricsController` |
| sensor-service | YES — bespoke `SensorMetricsController` |
| messaging-service | YES — bespoke domain-registry controller |
| observability-service | YES — own `PrometheusController` (InternalApiGuard-gated) |
| farm-service | **NO** — counted as "present" by the prior audit, but `FarmMetricsModule` registers counters + interceptors only; the `farm_*` domain registry had a `getMetrics()` dump and **no controller serving it**. Every farm domain metric was recorded and unreachable. |
| admin-api-service | **NO** — `SystemMetricsModule` is the admin ANALYTICS API (`GET /system/metrics`, JSON), not a Prometheus surface. Name-level audits miscounted it. |
| ai-service | **NO** — not even in the brief's missing list. |
| alert-engine, billing, hr, hydroponics, notification, config, event-store | **NO** — as the brief stated. |

**Plan-vs-reality corrections:** missing set was 10 (brief said 7): the
brief's 7 + ai-service + farm-service + admin-api-service. "Present" set
was 5, not 6.

### Root cause

`libs/backend-common/src/metrics/metrics.controller.ts` carried a
doc-comment claiming "the MetricsModule handles this by providing a factory
that creates a properly decorated controller for each service context" —
**that factory never existed**. The canonical `ServiceMetricsModule` was
not drop-in: its controller had no `@Public()`, no middleware wiring, so
every adopter had to hand-copy a 2-file wrapper (module + decorated
controller). Three services paid that cost; ten never did. Classic
adoption-tax failure: the right behaviour was not the zero-effort default.

Secondary root causes:

- The service catalog had no concept of a metrics/scrape surface, so no
  invariant COULD enforce completeness.
- `readinessServices()` hardcoded `port: 3000` for every node-service while
  observability-service listens on 3009 (`PORT: 3009` in
  docker-compose.droplet.yml; healthcheck probes `localhost:3009`). The
  generated `CATALOG_READINESS_SERVICES` therefore told
  `post-deploy-verify.sh` to `curl http://localhost:3000/health/ready`
  inside the observability container — a dead port. Latent false-negative
  in every readiness sweep that reaches that step.

### Fix (this PR) — tier classification per change

1. **Tier 2 (make it automatic)** — canonical `ServiceMetricsModule` is now
   genuinely drop-in: controller carries `@Public()` (every guard chain in
   the platform — backend-common TenantGuard/RolesGuard, gateway AuthGuard,
   billing JwtAuthGuard, admin PlatformAdminGuard — keys on the same
   `'isPublic'` metadata, verified file-by-file), and the module implements
   `NestModule` to self-apply `MetricsMiddleware`. Adoption = ONE import
   line. The lying doc-comment is replaced with the verified guard-survey.
2. **Tier 2** — `ServiceMetricsService.registerContributor(name, registry)`:
   domain modules with private prom-client registries surface them through
   the single scrape endpoint. farm-service wires
   `FarmDomainMetricsService.contributeTo()` in `FarmMetricsModule.onModuleInit`
   — the previously unreachable `farm_*` series now appear in scrape output
   (unit-tested end-to-end).
3. **Adoption** — 9 services register `ServiceMetricsModule` in
   `app.module.ts`: alert-engine, billing, hr, hydroponics, notification,
   config, event-store, ai, admin-api. farm-service adopts via
   `FarmMetricsModule` (which imports the canonical module).
4. **event-store-service guard** — `EventStoreServiceIdentityGuard` has no
   `@Public()` path by design (exact-match allowlist contract). `/metrics`
   joins the allowlist (`PUBLIC_OBSERVABILITY_PATHS`); spec extended with
   allow-`/metrics` + reject-`/metrics/extra` cases.
5. **Tier 1 (make it impossible)** — catalog SSoT
   (`platform/libs/service-catalog/src/index.ts`): new field
   `metricsExposure: 'prom-endpoint' | 'none'` (derived: node-service ⇒
   prom-endpoint). `validateServiceCatalog` REJECTS node-services without
   prom-endpoint — a new backend service cannot express the "no metrics"
   state. The scrape endpoint is served on the single Node HTTP listener
   (`containerPort`, shared with /health), so there is no separate metrics
   port: the Prometheus scrape and the readiness probe target one port.
   NOTE: `containerPort` (incl. the observability-service:3009 override and
   the readinessServices() port-derivation fix) is owned by INFRA-HIGH-014
   (#398), which merged first; this wave reuses it rather than adding a
   duplicate `metricsPort` field — per operator decision to keep one port
   SSoT and avoid containerPort↔metricsPort drift.
7. **Tier 3 (make it detectable)** —
   `tests/invariants/metrics-endpoint-adoption.spec.ts` (registry shard):
   for every prom-endpoint node-service, app.module.ts must register a
   metrics module AND the service tree must contain a real scrape surface
   (local `@Controller('metrics')` OR canonical module import). The
   two-part check exists precisely because name-level checks pass on
   admin's SystemMetricsModule and farm's FarmMetricsModule while
   Prometheus has nothing to scrape. **Negative test executed:** removing
   billing's registration turned the spec red (1 failed / 32 passed),
   restored after.
8. **Regenerated artifacts** (catalogHash kept in lockstep):
   `service-criticality.yaml`, `service-catalog.deploy.vars`,
   `service-catalog.generated.json`, `required-{signals,secrets}.yaml`,
   `apollo-router/subgraphs.json`, and the downstream
   `federated-subgraphs.generated.ts` registry pin.

### OPERATOR-APPROVAL ITEM — alert-engine criticality raised to `critical`

The catalog marked alert-engine `criticality: 'warning'` although it
produces life-safety alerts (dissolved-oxygen crash, escalation ladder).
Raised to `'critical'` in this PR. **Deploy-gate semantics change:**
`scripts/deploy/check-service-health.ts` now FAILS a deploy that leaves
alert-engine unhealthy (previously it only warned). No invariant pinned the
old level (`service-criticality-profile-contract.spec.ts` checks profiles
only, alert-engine has none); the generated manifest diff is
`alert-engine: warning → critical`. If an unhealthy-but-tolerated
alert-engine is currently relied upon during deploys, this will surface
immediately — that is the intended behaviour, but the operator should
consciously accept it.

### Deliberately NOT done (scope boundary, with reasons)

- **Bespoke wrapper modules (gateway-api, auth-service, sensor-service)
  were NOT migrated** to the canonical module. They are working scrape
  endpoints on critical-path services; both shapes satisfy the new
  invariant, so the duplication cannot grow to new services. Unifying them
  is pure consolidation with its own blast radius and belongs to its own
  reviewed change.
- **messaging-service scrape output still lacks `http_*`/`nodejs_*`
  families** (its controller serves only the domain registry). Registered
  as ORPHAN finding in `docs/reviews/orphan-findings.md` (see
  ORPHAN-MEDIUM-089) with the contributor-pattern fix direction.
- **No scrape collector exists on the droplet runtime** — the
  kube-prometheus-stack values under `infrastructure/monitoring/` are
  Kubernetes-only; docker-compose.droplet.yml ships no Prometheus
  container. This PR makes every backend scrapable and gives the catalog
  the scrape-target SSoT (`metricsExposure` + `containerPort`) a collector
  config generator must consume. Registered as ORPHAN finding
  (ORPHAN-HIGH-090).
- **observability-service's own /metrics stays InternalApiGuard-gated**
  (scraper must send `x-internal-api-key`) — divergent from the
  platform-wide public-on-internal-network convention but a deliberate
  pre-existing security posture; noted, not changed.

### Evidence

- `libs/backend-common/src/metrics/metrics.module.ts` (drop-in contract)
- `libs/backend-common/src/metrics/metrics.controller.ts` (@Public + guard survey)
- `libs/backend-common/src/metrics/metrics.service.ts` (contributor registries)
- `apps/farm-service/src/common/metrics/farm-metrics.module.ts` (domain wiring)
- `apps/event-store-service/src/guards/event-store-service-identity.guard.ts:18`
- `platform/libs/service-catalog/src/index.ts` (MetricsExposure field +
  validateServiceCatalog; scrape reuses containerPort from INFRA-HIGH-014)
- `infrastructure/deploy/service-catalog.deploy.vars` (`observability-service:3009`)
- `infrastructure/deploy/service-criticality.yaml` (`alert-engine: critical`)
- `tests/invariants/metrics-endpoint-adoption.spec.ts` (33 assertions green;
  negative test red as expected when a registration is removed)

### Validation

- `npm run invariants:fast` — 69/69 suites, 1063 tests green (includes the
  new spec and the regenerated-artifact parity suite).
- `libs/backend-common` metrics unit tests — 15/15 green (3 new contributor
  tests: aggregation, cache invalidation, idempotent re-registration).
- `apps/event-store-service` identity-guard suite green with the new
  /metrics allow + /metrics/extra reject cases.
- farm-service domain-metrics suite green incl. new `contributeTo`
  end-to-end test.
- Platform-wide `npm run type-check` green.
- Negative invariant proof: billing registration removed → spec fails;
  restored → spec green.
