# Research: Production Observability — Prometheus Alerts, Loki Logs, Grafana SLO/SLI Dashboards

**Topic:** Production observability stack — Prometheus alert rules (service down, high error rate, high latency, disk/memory pressure), SLO/SLI with multi-burn-rate alerts, Loki log aggregation, Grafana dashboards for golden signals, PagerDuty/Slack notification channels.
**Date:** 2026-04-08
**Agent:** infra-expert

## Sources
- [prometheus.io: Alerting Rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)
- [prometheus.io: Recording Rules](https://prometheus.io/docs/prometheus/latest/configuration/recording_rules/)
- [prometheus.io: Best practices — histograms and summaries](https://prometheus.io/docs/practices/histograms/)
- [Awesome Prometheus Alerts (community curated ruleset)](https://samber.github.io/awesome-prometheus-alerts/)
- [grafana.com: Alerting and recording rules for Loki](https://grafana.com/docs/loki/latest/alert/)
- [grafana.com: Loki best practices](https://grafana.com/docs/loki/latest/best-practices/)
- [grafana.com: Grafana SLO introduction](https://grafana.com/docs/grafana-cloud/alerting-and-irm/slo/introduction/)
- [Google SRE Book: Chapter 4 — Service Level Objectives](https://sre.google/sre-book/service-level-objectives/)
- [Google SRE Workbook: Implementing SLOs](https://sre.google/workbook/implementing-slos/)
- [Google SRE Book: Chapter 6 — Monitoring Distributed Systems (Four Golden Signals)](https://sre.google/sre-book/monitoring-distributed-systems/)
- [AWS Well-Architected: Operational Excellence Pillar](https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/welcome.html)
- [The RED Method — Tom Wilkie](https://www.weave.works/blog/the-red-method-key-metrics-for-microservices-architecture/)
- [The USE Method — Brendan Gregg](https://www.brendangregg.com/usemethod.html)

## Key Findings

1. **Four Golden Signals (Google SRE).** Every service MUST expose metrics for:
   - **Latency:** request duration (histogram with p50/p95/p99)
   - **Traffic:** request rate (requests per second)
   - **Errors:** error rate (failed requests / total requests)
   - **Saturation:** how full the service is (CPU, memory, queue depth, connection pool utilization)
   
   RED (Rate, Errors, Duration) for request-driven services; USE (Utilization, Saturation, Errors) for resources.

2. **Standard alert rule set (minimum viable).** Every production service MUST have rules for:
   ```yaml
   groups:
     - name: service-slo
       rules:
         - alert: ServiceDown
           expr: up{job="api"} == 0
           for: 2m
           labels: { severity: critical }
           annotations:
             summary: "Service {{ $labels.job }} is down"
             runbook_url: "https://runbooks.example.com/service-down"
         
         - alert: HighErrorRate
           expr: |
             sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
             / sum(rate(http_requests_total[5m])) by (service) > 0.05
           for: 5m
           labels: { severity: high }
         
         - alert: HighLatencyP99
           expr: |
             histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, service)) > 1.0
           for: 10m
           labels: { severity: high }
         
         - alert: HighMemoryPressure
           expr: |
             (container_memory_working_set_bytes / container_spec_memory_limit_bytes) > 0.90
           for: 5m
           labels: { severity: high }
         
         - alert: DiskPressure
           expr: |
             (node_filesystem_size_bytes - node_filesystem_avail_bytes) / node_filesystem_size_bytes > 0.85
           for: 10m
           labels: { severity: high }
         
         - alert: HighCPU
           expr: |
             rate(container_cpu_usage_seconds_total[5m]) > 0.90
           for: 10m
           labels: { severity: medium }
   ```
   Missing any of these base alerts on a production service = HIGH.

3. **SLO/SLI with multi-burn-rate alerts (Google SRE Workbook).** Single-threshold alerts are noisy or slow. Multi-window, multi-burn-rate pages on both fast burns (large error budget consumption in short window) and slow burns (sustained small degradation). Standard pattern for 99.9% availability SLO (0.1% error budget):
   ```yaml
   # Fast burn: 2% of monthly budget in 1h → page
   - alert: ErrorBudgetBurnFast
     expr: |
       (sum(rate(http_requests_total{status=~"5.."}[1h])) / sum(rate(http_requests_total[1h]))) > (14.4 * 0.001)
       and
       (sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))) > (14.4 * 0.001)
     labels: { severity: critical, burn_rate: fast }
   
   # Slow burn: 10% of monthly budget in 6h → page
   - alert: ErrorBudgetBurnSlow
     expr: |
       (sum(rate(http_requests_total{status=~"5.."}[6h])) / sum(rate(http_requests_total[6h]))) > (6 * 0.001)
       and
       (sum(rate(http_requests_total{status=~"5.."}[30m])) / sum(rate(http_requests_total[30m]))) > (6 * 0.001)
     labels: { severity: high, burn_rate: slow }
   ```
   Simple threshold alerts without burn-rate math = MEDIUM (noisy or slow).

4. **Histogram buckets tuned to SLO.** `http_request_duration_seconds` buckets MUST include values near the SLO latency target. Default prom client buckets `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` are OK for most web APIs but may need adjustment for stricter SLOs. `histogram_quantile(0.99, ...)` of a histogram with no bucket near 99p = useless.

5. **Labels: low cardinality.** Never label with user_id, tenant_id, request_id, IP. These explode Prometheus memory (one series per unique combo). Allowed labels: service, method, route template (`/api/users/:id`, not `/api/users/42`), status_code, environment. High-cardinality labels = CRITICAL (Prometheus OOM).

6. **Recording rules for expensive queries.** If a dashboard query takes > 1s, make it a recording rule:
   ```yaml
   - record: service:http_request_error_rate_5m
     expr: |
       sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
       / sum(rate(http_requests_total[5m])) by (service)
   ```
   Dashboards then read the pre-aggregated series instead of recomputing.

7. **Loki for logs, not as a metrics store.** Loki is cheap because it indexes only labels (not log content). Labels MUST be low-cardinality: `{app, namespace, container, level}`. Never label with trace_id, request_id, user_id — same reason as Prometheus. Querying unstructured content uses LogQL's `|=`, `|~`, `| json`. Missing structured log fields (JSON) = MEDIUM (LogQL filtering slow).

8. **Log-derived metrics via Loki recording rules.** For events not natively instrumented, derive metrics from logs:
   ```
   - record: service:log_errors_total
     expr: sum by (service) (count_over_time({app="api"} |= "ERROR" [5m]))
   ```

9. **Grafana dashboards per service + overview.** Pattern:
   - **Overview dashboard:** platform health, error budget burn, total RPS, P99 latency across all services.
   - **Per-service dashboard:** RED metrics (rate, errors, duration) + saturation (CPU, memory, DB connections, queue depth).
   - **Per-domain dashboard:** business metrics (e.g., sensor readings ingested/sec, batch harvests completed/day).
   - Dashboards MUST have clear units, time range defaults, and descriptions. Untitled panels = LOW but quality signal.

10. **Alertmanager routing and receivers.** Severity-based routing:
    ```yaml
    route:
      receiver: default
      group_by: [alertname, service]
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
        - matchers: [severity="critical"]
          receiver: pagerduty
          group_wait: 0s
          repeat_interval: 1h
        - matchers: [severity="high"]
          receiver: slack-oncall
        - matchers: [severity="medium"]
          receiver: slack-dev
    ```
    Missing severity-based routing = MEDIUM (either alert fatigue or missed pages).

11. **Every alert MUST have `runbook_url`.** Paging someone at 3 AM without a runbook = cruel and ineffective. Runbook in wiki or Git with steps: diagnose, mitigate, escalate.

12. **Dead-man's switch (inverse alert).** `ALWAYS-FIRING` dummy alert that must always fire — silence = Prometheus or Alertmanager broken. Pairs with PagerDuty's "no incident" alert.

13. **Inhibit rules.** A `ServiceDown` alert should inhibit `HighErrorRate` for the same service — avoid double paging for the same root cause.

14. **Long-term storage.** Prometheus local TSDB is 15-day default. For audit/compliance/trend analysis use Mimir, Thanos, or Cortex for 1+ year retention. Missing long-term storage = MEDIUM.

## Security Concerns
- Prometheus `/metrics` endpoint publicly accessible = HIGH (info disclosure).
- Loki write endpoint without auth = CRITICAL (log injection/tampering).
- Grafana with default admin/admin credentials = CRITICAL.
- Grafana without SSO/OIDC = MEDIUM.
- Metric labels containing PII (user_id, email) = CRITICAL (PII in observability backend + cardinality explosion).
- Logs containing credentials/tokens = CRITICAL (must be scrubbed at source).

## Performance / Cardinality Concerns
- High-cardinality label on Prometheus metric (user_id, request_id, IP) = CRITICAL (OOM risk).
- Histogram with wrong bucket distribution = HIGH (useless percentiles).
- Dashboard query without recording rule taking > 1s = MEDIUM.
- Loki label with high cardinality (trace_id, user) = CRITICAL (Loki index explosion).
- Missing rate-limit / ingestion-limit on Loki = HIGH.

## Observability Gaps
- Missing `up` alert = CRITICAL (service down undetected).
- Missing error rate alert = HIGH.
- Missing latency alert = HIGH.
- Missing saturation alerts (memory, CPU, disk) = HIGH.
- Missing SLO with error budget = MEDIUM.
- Missing multi-burn-rate alerts = MEDIUM.
- Missing runbook_url on any alert = MEDIUM.
- No dead-man's switch = MEDIUM.
- Alerts without severity label = MEDIUM.

## Architectural Implications for infra-expert reviews
- Every production service MUST expose all four golden signals.
- Every service MUST have the minimum alert rule set (up, error rate, latency, memory, disk).
- Alert labels MUST be low cardinality.
- All alerts MUST have `severity` label and `runbook_url` annotation.
- Grafana dashboards MUST cover platform overview + per-service RED/USE.
- Alertmanager MUST route by severity (critical→PD, high→Slack oncall, medium→Slack dev).
- Dead-man's switch and inhibit rules MUST be configured.

## Domain Rule Additions for infra-expert

Add to `## Domain Rules → Monitoring`:
- Every production service MUST expose the four golden signals (latency histogram, request rate, error rate, saturation metrics); missing any = HIGH.
- Standard alert rules (ServiceDown, HighErrorRate, HighLatencyP99, HighMemoryPressure, DiskPressure) MUST exist for every production service; missing = HIGH.
- User-facing services SHOULD define SLOs with multi-burn-rate alerts (fast + slow burn windows); missing = MEDIUM.
- Prometheus metric labels MUST be low cardinality; high-cardinality labels (user_id, request_id, IP) = CRITICAL.
- Histogram buckets MUST include values near the SLO latency target; wrong distribution = HIGH.
- Every alert MUST carry `severity` label and `runbook_url` annotation; missing = MEDIUM.
- Alertmanager MUST route by severity (critical → PagerDuty, high → Slack oncall, medium → Slack dev); missing = MEDIUM.
- A dead-man's switch alert MUST always fire (silence = monitoring broken); missing = MEDIUM.
- Inhibit rules MUST prevent double-paging on cascading failures (e.g., ServiceDown inhibits HighErrorRate); missing = LOW.
- Loki labels MUST be low cardinality; high-cardinality labels = CRITICAL.
- Logs MUST be emitted as structured JSON for LogQL filtering; unstructured only = MEDIUM.
- Prometheus `/metrics` endpoint MUST be IP-restricted or auth-protected; public = HIGH.
- Grafana MUST NOT use default credentials; MUST integrate with SSO/OIDC for prod; default creds = CRITICAL.
- Long-term metric storage (Mimir/Thanos) SHOULD be configured for > 30-day retention; missing = MEDIUM.
- Expensive dashboard queries (> 1s) MUST be converted to recording rules; missing = MEDIUM.
