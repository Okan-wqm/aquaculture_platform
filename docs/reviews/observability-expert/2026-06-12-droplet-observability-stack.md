# Droplet observability stack-as-code (B2) — scrape-target SSoT

**Date:** 2026-06-12
**Agent:** observability-expert (lead-verified)
**Wave:** B2 (S2). Builds on B1 (OBS-HIGH-001 — every backend exposes /metrics).
**Activation:** droplet-resize gated. This wave ships the stack AS CODE + CI
validation; runtime activation stays structurally blocked behind a
`MemAvailable` Tier-1 preflight (no override).

---

## OBS-HIGH-002 — Droplet observability is not deployable as code; nothing generates Prometheus scrape targets from the catalog SSoT

**Problem.** B1 (OBS-HIGH-001) made all 14 active-droplet backends expose a
Prometheus `/metrics` surface on their shared HTTP port (`containerPort`). But
**ORPHAN-HIGH-090** confirmed firsthand that the droplet runs no collector and —
more structurally — **nothing emits a scrape config**: `docker-compose.droplet.yml`
has zero monitoring containers, and `scripts/service-catalog/generate-artifacts.ts`
emitted six artifacts but **no Prometheus scrape targets**. The pre-existing
monitoring tree (`infrastructure/monitoring/**`) is Kubernetes-only
(kube-prometheus-stack helm values, annotation-based discovery) and does not
apply to the single-node Docker droplet. A hand-written `prometheus.yml` scrape
list would be the classic silent-drift trap: a new backend ships, nobody adds it
to the static list, it is simply never scraped, and the gap surfaces only during
an incident.

**Firsthand validation (the plan-gated status_code question).** The dormant
alert rules diverge on the HTTP error-rate label:
- `infrastructure/monitoring/prometheus/aquaculture-rules.yaml` uses label
  `status` (e.g. `http_request_duration_seconds_count{status=~"5.."}`).
- `infrastructure/monitoring/prometheus/alerts/slo-alerts.yml` uses `status_code`.
- The **actual** backend metric (`libs/backend-common/src/metrics/metrics.service.ts:94,104`)
  emits label **`status_code`** on `http_request_duration_seconds` +
  `http_requests_total`.

So `aquaculture-rules.yaml`'s error-rate rules are **broken** (`status` matches
nothing) and must be fixed `status` → `status_code` when extracted for the
droplet. `slo-alerts.yml` is already correct. (Recorded so the rules-extraction
slice does not re-introduce the bug.)

---

## D3 (this commit) — catalog → Prometheus `file_sd` generator + drift gate

`scripts/service-catalog/generate-artifacts.ts` gains
`prometheusScrapeTargetsArtifact()`, emitting
`infrastructure/monitoring/droplet/file_sd/aqua-services.json`: one target group
per catalog service with `metricsExposure === 'prom-endpoint'`, keyed by
`composeServiceName:containerPort` (the shared `/metrics`+`/health` listener;
there is no separate `metricsPort`), labelled `app` (the alert rules' `by (app)`
group key) + `namespace=aquaculture` + `criticality` (Alertmanager routing,
single source of truth). Output is the native Prometheus file_sd shape (a bare
array of target groups) so the scraper accepts it directly; provenance is
enforced by the generator's `--check` mode, not an in-file metadata object.

**Make-it-detectable.** `tests/invariants/monitoring-scrape-catalog-sync.spec.ts`
(registry shard, runs in `invariants:fast`) re-derives the expected target set
from the catalog and asserts the committed file_sd matches exactly — a catalog
change that is not regenerated, or a hand-edit, fails at PR time. 14 targets
generated; invariant 4/4.

### Validation
- `npm run service-catalog:generate` then `--check` → no drift (exit 0).
- `monitoring-scrape-catalog-sync.spec.ts`: **4/4**.
- `invariant-reachability.spec.ts`: still green (the new spec is listed).
- Target hostnames verified resolvable: compose service key `gateway-api`
  (container_name `aqua-gateway`) is a Docker DNS alias on `aqua-network` /
  `aqua-internal`, so `gateway-api:3000` resolves from a monitoring container on
  the shared network.

## NOT done here (remaining B2 slices, same finding)
`docker-compose.monitoring.yml` (separate `aqua-monitoring` compose project so
the app deploy's `--remove-orphans` cannot kill it; `oom_score_adj`, read-only
rootfs, loopback-only publish) · `prometheus.yml` consuming the file_sd +
per-target `/metrics` auth for the gated observability-service endpoint · the 6
rule files extracted from the dormant K8s rules **with the `status`→`status_code`
fix + `runbook_url` on every rule** · `alertmanager.yml` (criticality routing) ·
Grafana Alloy log shipper (Promtail is EOL) · Grafana provisioning + dashboards ·
`scripts/monitoring/*` (the single activation path) · `monitoring-stack-validate.yml`
(promtool / amtool / `compose config` in pinned images) · the droplet
observability ADR + alert runbooks. Activation (B4/B5) stays resize-gated.
