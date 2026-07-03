# Aquaculture Platform - SLO/SLI Definitions

> **Owner:** Platform Team
> **Effective Date:** 2026-03-14
> **Review Cadence:** Quarterly

## Overview

This document defines the Service Level Objectives (SLOs) and Service Level Indicators (SLIs)
for the Aquaculture Platform. These targets establish the reliability contract between the
platform team and its users. All SLOs are enforced via Prometheus alert rules defined in
`infrastructure/monitoring/prometheus/alerts/slo-alerts.yml`.

---

## SLI / SLO Definitions

| # | SLI | Measurement | SLO Target | Window | Severity on Breach |
|---|-----|-------------|------------|--------|--------------------|
| 1 | Gateway availability | `up{app="gateway-api"}` ratio | >= 99.9% | 30 days (rolling) | critical |
| 2 | API latency p95 | `histogram_quantile(0.95, http_request_duration_seconds_bucket)` | < 500 ms | 30 days (rolling) | warning |
| 3 | API latency p99 | `histogram_quantile(0.99, http_request_duration_seconds_bucket)` | < 2000 ms | 30 days (rolling) | critical |
| 4 | Error rate (5xx) | `rate(http_requests_total{status_code=~"5.."}[...]) / rate(http_requests_total[...])` | < 0.1% | 30 days (rolling) | critical |
| 5 | Sensor data freshness | `time() - max(sensor_reading_timestamp)` | < 60 s lag | 30 days (rolling) | warning |
| 6 | Login success rate | `rate(auth_login_success_total) / rate(auth_login_attempts_total)` | >= 99.5% | 7 days (rolling) | warning |
| 7 | Webhook processing latency | `histogram_quantile(0.95, webhook_processing_duration_seconds_bucket)` | < 5 s | 30 days (rolling) | warning |
| 8 | Auth login latency p99 (tier-0) | `histogram_quantile(0.99, auth_operation_duration_seconds_bucket{operation="login"})` | < 500 ms | 30 days (rolling) | warning |
| 9 | Auth token-validation latency p99 (tier-0) | `histogram_quantile(0.99, auth_operation_duration_seconds_bucket{operation="token_validation"})` | < 200 ms | 30 days (rolling) | warning |

> **Tier-0 auth latency (SLI 8 & 9, PERF-MEDIUM-003):** login and token-validation
> are GraphQL operations served on `/graphql`, so the route-blind
> `http_request_duration_seconds` histogram (SLI 2/3) cannot isolate them. They are
> measured directly by `auth_operation_duration_seconds` (auth-service
> `AuthDomainMetricsService`), labelled by `operation` (`login` /
> `token_validation`) and `outcome` (`success` / `error` — failed logins are part
> of the latency budget). The 500 ms login target sits **above** the ~200 ms
> constant-time login floor (the deliberate timing-attack mitigation), so the alert
> fires on real regression, not the floor itself. Alerts: `SloAuthLoginP99High`,
> `SloAuthTokenValidationP99High`.

---

## Error Budget

### What is an error budget?

An error budget is the maximum amount of unreliability the platform can tolerate within a
given window before corrective action is required.

### Budget calculations (30-day window)

| SLO | Error Budget (per 30 days) | Equivalent |
|-----|---------------------------|------------|
| 99.9% availability | 0.1% of 43,200 min = **43.2 minutes** downtime | ~2.6 seconds/hour |
| 99.5% login success (7d) | 0.5% of all login attempts over 7 days | Varies with traffic |
| < 0.1% error rate | Up to 0.1% of all requests may be 5xx | Varies with traffic |

### Burn rate alerts

Burn rate measures how fast the error budget is being consumed relative to the budget window.
If the current error rate is constant and would exhaust the budget faster than expected,
we trigger alerts at two thresholds:

| Alert | Burn Rate | Window | Meaning |
|-------|-----------|--------|---------|
| `SloErrorBudgetFastBurn` | 14.4x | 1 hour (short) + 5 min (fast) | Budget will exhaust in ~2 days at current rate. **Page immediately.** |
| `SloErrorBudgetSlowBurn` | 6x | 6 hours (short) + 30 min (fast) | Budget will exhaust in ~5 days at current rate. **Create ticket.** |

The multi-window approach (long + short window) reduces false positives by requiring
sustained elevated error rates in both windows before firing.

---

## Metric Dependencies

The following custom metrics **must** be exported by the respective services for these SLOs
to be measurable:

| Metric | Type | Exported By | Labels |
|--------|------|-------------|--------|
| `http_request_duration_seconds` | Histogram | All HTTP services (via NestJS prom-client) | `method`, `route`, `status` |
| `http_requests_total` | Counter | All HTTP services | `method`, `route`, `status_code` |
| `sensor_reading_timestamp` | Gauge | sensor-service | `sensor_type` |
| `auth_login_attempts_total` | Counter | auth-service | `result` (success/failure) |
| `auth_login_success_total` | Counter | auth-service | - |
| `webhook_processing_duration_seconds` | Histogram | gateway-api / alert-service | `webhook_type` |

> **Note:** If a metric is not yet instrumented, the corresponding SLO alert will not fire
> (PromQL returns empty on missing series). Implementing these metrics is tracked in the
> platform backlog.

---

## Escalation Policy

| Severity | Action | Response Time | Example |
|----------|--------|---------------|---------|
| `critical` | Page on-call engineer (PagerDuty) | < 15 min acknowledgement | Gateway down, budget fast-burn |
| `warning` | Create ticket (Jira/Linear) | < 4 hours triage | p95 latency breach, slow-burn |
| `info` | Dashboard visibility only | Next business day | Approaching threshold |

---

## Review Process

1. **Weekly:** Review error budget consumption in Grafana SLO dashboard.
2. **Monthly:** Assess if SLO targets are appropriate given observed traffic patterns.
3. **Quarterly:** Formal SLO review meeting. Adjust targets if needed. Update this document.
4. **Post-incident:** If an SLO is breached, conduct a blameless postmortem and determine
   if the SLO target or alerting thresholds need adjustment.

---

## Related Resources

- Alert rules: `infrastructure/monitoring/prometheus/alerts/slo-alerts.yml`
- Existing operational alerts: `infrastructure/monitoring/prometheus/aquaculture-rules.yaml`
- Prometheus values: `infrastructure/monitoring/prometheus/prometheus-values.yaml`
- Alertmanager routing: See `alertmanager.config.route` in prometheus-values.yaml
