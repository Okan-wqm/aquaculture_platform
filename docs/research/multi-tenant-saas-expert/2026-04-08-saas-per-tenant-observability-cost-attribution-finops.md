# Research: Per-Tenant Observability and Cost Attribution (FinOps)

**Topic:** Prometheus label cardinality, per-tenant SLOs, cost attribution, FinOps per-tenant, tenant dashboards
**Date:** 2026-04-08
**Agent:** multi-tenant-saas-expert

## Sources

- Grafana Cloud documentation, "Analyze Prometheus metrics costs" and "Cardinality management dashboards": https://grafana.com/docs/grafana-cloud/cost-management-and-billing/analyze-costs/metrics-costs/prometheus-metrics-costs/cardinality-management/
- Google Cloud Observability, "Cost controls and attribution": https://cloud.google.com/stackdriver/docs/managed-prometheus/cost-controls
- Prometheus best practices, "Instrumentation" and "Labels": https://prometheus.io/docs/practices/instrumentation/ — "avoid labels with unbounded cardinality".
- AWS Cost Explorer 2026 Cost Comparison feature guidance.
- FinOps Foundation, "FinOps Framework": https://www.finops.org/framework/ — cost allocation, showback/chargeback.
- ThoughtWorks Tech Radar — OpenTelemetry, exemplars, histogram quantile guidance.
- CNCF OpenTelemetry spec — resource attributes, span attributes.
- Aqua-saas codebase: `apps/observability-service/`, `libs/backend-common/src/audit/audit-log.service.ts`.

## Key Findings

1. **Cardinality explosion is the dominant observability failure mode.** A naive `http_requests_total{tenant_id="..."}` labels blows up at O(tenants × endpoints × status × method) ≈ O(10^5) at 100 tenants × 250 endpoints × 5 status × 4 methods = 500K active series — per process. Multiply by replica count and you hit ingestion limits fast.
2. **Bounded cardinality rule.** Prometheus docs: "avoid labels with unbounded cardinality". For per-tenant labels, the accepted pattern is:
   - **Hot-path metrics** (request counts, latencies) exclude `tenant_id`. Per-tenant breakdown comes from logs / traces, not metrics.
   - **Plan-tier label** (`plan=starter|professional|enterprise|custom`) is always safe — bounded to 4 values.
   - **Per-tenant metrics** limited to slow-moving series: `tenant_info{tenant_id, plan}` (gauge, one-per-tenant), `tenant_storage_used_bytes{tenant_id}`, `tenant_quota_remaining{tenant_id}`, `tenant_active_users{tenant_id}`. All measured once per scrape interval.
   - **Top-N tenants by metric** — pre-aggregate the top N noisy tenants in the application and expose only `top_n_tenants{rank="1", tenant_id="..."}`.
3. **Exemplars are the escape hatch** — attach a traceID to a histogram bucket so drilling from a p99 latency spike finds the exact trace and tenant without cardinality blowup.
4. **Per-tenant cost attribution** requires logs + traces, not just metrics. Structured log lines carry `tenantId` for every significant operation; cost jobs aggregate log volume × ingestion cost to produce per-tenant showback.
5. **Per-tenant SLO** must be computed from pre-aggregated per-tenant counters, never naive label explosion. Use recording rules that roll up per-tenant counters on a dedicated time window (hourly / daily).
6. **FinOps per-tenant** breakdown covers:
   - **Compute** — proportional to CPU-seconds per tenant (from OpenTelemetry span duration × instance cost).
   - **Database** — proportional to query count × query duration per tenant.
   - **Storage** — direct measurement (`tenant_storage_used_bytes`).
   - **Egress** — bytes transferred per tenant (web-server access logs + object-storage egress).
   - **AI / LLM** — token cost per tenant from the AI service's billing log.
7. **Per-tenant SLO dashboard** — availability, latency p50/p95/p99, error rate, quota usage, each broken by tenant ID from the log pipeline (Loki / ELK), not from Prometheus labels.
8. **Showback vs chargeback.** FinOps Foundation framework: showback (visibility only) is the baseline; chargeback (actual bill-back) requires accurate per-tenant cost allocation and a commercial agreement.
9. **High-cardinality log pipeline.** Logs are allowed to carry `tenantId` because log storage is cheaper per-series than metrics; however, log volume per tenant must itself be bounded (per-tenant log quota to prevent a single tenant from burning the log pipeline).
10. **Tenant-label injection defense.** Metrics that DO carry `tenant_id` (info, storage, quota) must validate the tenantId against the registry before emitting — a compromised code path emitting a forged tenantId creates phantom series.

## Security Concerns

- **Cardinality DoS via user-controlled labels.** Any metric label sourced from user input without validation allows an attacker to generate millions of unique labels, crashing the TSDB.
- **PII in metric labels.** Emails, IPs, usernames as labels is a GDPR Art. 32 breach AND a cardinality disaster.
- **Cross-tenant leak via metric query.** A query `{tenant_id=".*"}` across all tenants by a non-SUPER_ADMIN user leaks tenant presence (enumeration).
- **Tenant ID in span attributes** is acceptable in the trace backend (Tempo / Jaeger) because traces are indexed differently and trace query is SUPER_ADMIN only.

## Performance Concerns

- **Recording rules for per-tenant rollups** run every 30-60 s and are cheap; naive high-cardinality metrics are expensive.
- **Log pipeline ingestion** is the bottleneck at scale — per-tenant log quota prevents one tenant from consuming all ingestion budget.
- **Exemplar storage** is bounded per bucket — not a cardinality risk.

## Architectural Implications for multi-tenant-saas-expert reviews

- Flag any hot-path metric emitting `tenant_id` as HIGH (cardinality blowup).
- Flag any metric label sourced from untrusted user input without validation as CRITICAL.
- Flag PII in metric labels as CRITICAL.
- Flag missing per-tenant log quota as HIGH.
- Flag any non-SUPER_ADMIN API that exposes cross-tenant metrics as HIGH (enumeration).
- Require per-tenant SLO breakdown to come from pre-aggregated recording rules OR log pipeline, not raw hot-path metrics.
- Require top-N aggregation for noisy-neighbor detection dashboards.

## Domain Rule Additions for multi-tenant-saas-expert

- **Hot-path metrics exclude `tenant_id` label.** Per-tenant breakdown from logs / traces. Hot metric with `tenant_id` = HIGH (cardinality blowup).
- **Bounded-cardinality tenant labels allowed** on slow-moving series: `tenant_info`, `tenant_storage_used_bytes`, `tenant_quota_remaining`, `tenant_active_users`. Documented list; undocumented `tenant_id` usage = HIGH.
- **Plan-tier label is always safe** (`plan=starter|professional|enterprise|custom`).
- **Top-N pre-aggregation** in the application, expose only `top_n_{metric}{rank, tenant_id}` with bounded rank ≤ 20.
- **Exemplars with traceID + tenantID** are the approved escape hatch for drilling into high-cardinality scenarios.
- **Metric label validation.** Any `tenant_id` label value must be registry-validated before emission. Unvalidated = CRITICAL (cardinality DoS / forgery).
- **No PII in metric labels.** Email / IP / username as label = CRITICAL.
- **Per-tenant log quota.** Missing = HIGH (log pipeline DoS by one tenant).
- **Per-tenant SLO recording rules** roll up hourly / daily on pre-aggregated counters. Missing = MEDIUM.
- **Cost attribution buckets** — compute / DB / storage / egress / AI. Each bucket has a per-tenant breakdown job. Missing any bucket = MEDIUM.
- **Cross-tenant metric query** restricted to SUPER_ADMIN. Exposing `{tenant_id=".*"}` to tenant users = HIGH (enumeration).
- **Trace backend tenantId indexing** — tenantId as a searchable attribute in Tempo/Jaeger is acceptable, but trace search must be SUPER_ADMIN gated.
