# ADR-005: OpenSearch Centralised Logging — SUPERSEDED / DEFERRED

**Status:** SUPERSEDED by current reality (2026-04-16 — retrodocumented during W1 audit)
**Original intent:** Accepted (date unknown; file was 0 bytes until W1 audit)

## Why this ADR was superseded

W1 audit flagged as **phantom ADR**: "Accepted" but zero implementation. No `opensearch` / `@elastic` deps in `package.json`, no Filebeat / Logstash / Fluentd config, no OpenSearch index templates, no log shippers.

## Current reality (logging + observability)

- **Structured JSON logs** via NestJS `Logger` wrapped by `StructuredLoggerService` (`libs/backend-common/src/logging/`), stdout per 12-factor.
- **`maskPii()`** auto-applied by the logger at emit time (CLAUDE.md Security).
- **Docker / K8s log aggregation** via platform runtime (droplet: Docker log driver; helm: node-level collector).
- **Prometheus metrics** for structured numeric observability (`libs/backend-common/src/metrics/`).
- **`tracing-opentelemetry` 0.28** compiled into Rust edge but **zero `#[instrument]` spans** across 943 pub fns (W1 EDGE-MEDIUM — add spans W7).
- **No centralised log search UI** — today `docker logs` / `kubectl logs` + grep + jq. Acceptable for current traffic; won't scale past ~50 tenants.

## If OpenSearch (or equivalent) adoption is reopened

Open new ADR when log volume / incident-response forces adoption:
- Specific incident motivation (not resolvable by `docker logs | jq`).
- OpenSearch vs Loki vs CloudWatch Insights vs equivalent.
- Schema + retention; PII masking persists (`maskPii()` runs at emit).
- Cost model vs current ($0 today).
- Migration path — most likely "add log shipper, keep StructuredLoggerService emitting JSON".

## References

- `/var/aqua-saas/libs/backend-common/src/logging/structured-logger.service.ts`
- `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-adr-drift-matrix.md`
- `/root/.claude/plans/declarative-riding-shamir.md` BLOCKER-18
