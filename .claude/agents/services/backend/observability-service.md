---
name: observability-service
description: Knowledge base for observability-service - Prometheus metrics exposure, distributed tracing, metrics aggregation for platform monitoring
---

# Observability Service Knowledge Base

## Overview
The observability-service provides centralized monitoring infrastructure for the aquaculture platform. It exposes Prometheus metrics, handles distributed tracing, and aggregates metrics from other services. It is an infrastructure service accessed only by monitoring systems (Prometheus, Grafana, Jaeger) and not directly by business logic. Protected by an `InternalApiGuard`.

## Directory Structure
```
apps/observability-service/src/
  app.module.ts              # Root - Prometheus, Tracing, Metrics Aggregator, Health
  main.ts
  guards/
    internal-api.guard.ts    # Restricts access to internal/monitoring clients only

  prometheus/
    prometheus.module.ts
    prometheus.controller.ts  # REST endpoint for Prometheus scraping (/metrics)
    prometheus.service.ts     # Manages Prometheus metric definitions and updates

  metrics/
    metrics-aggregator.module.ts
    metrics-aggregator.controller.ts  # REST endpoint for metrics aggregation queries
    metrics-aggregator.service.ts     # Collects and aggregates metrics from services

  tracing/
    tracing.module.ts
    tracing.controller.ts    # REST endpoint for trace ingestion/querying
    tracing.service.ts       # OpenTelemetry/Jaeger integration

  health/
    health.module.ts
    health.controller.ts
    health.service.ts
```

## Modules & Features

### PrometheusModule
- `PrometheusService`: creates and manages Prometheus metric types (Counter, Gauge, Histogram, Summary)
- `PrometheusController`: exposes `/metrics` endpoint in Prometheus text format
- Scrapes metrics from all backend services and re-exposes them
- Custom metrics: sensor ingestion rate, alert trigger rate, API response times, tenant counts

### MetricsAggregatorModule
- `MetricsAggregatorService`: collects metrics from multiple backend services
- `MetricsAggregatorController`: REST API for querying aggregated metrics
- May implement push or pull model for metric collection

### TracingModule
- `TracingService`: OpenTelemetry-compatible trace management
- `TracingController`: REST endpoint for trace ingestion or querying
- Integration with Jaeger or Zipkin for distributed trace storage and visualization

### HealthModule
- REST endpoint `/health` with dependency health checks
- `HealthService`: checks connectivity to PostgreSQL, Redis, NATS, and downstream services

## Key Entities
No TypeORM entities - this service does not own persistent data (metrics are ephemeral or stored in Prometheus/Jaeger).

## API (REST only - no GraphQL)

### Prometheus Endpoints
```
GET /metrics              # Prometheus scrape endpoint (text/plain)
```

### Metrics Aggregator Endpoints
```
GET /metrics/aggregated   # Aggregated metrics from all services
GET /metrics/service/:name  # Metrics for specific service
POST /metrics/record      # Record a custom metric event
```

### Tracing Endpoints
```
POST /traces              # Ingest trace spans
GET  /traces/:traceId     # Get trace details
```

### Health Endpoint
```
GET /health               # Service health + dependencies
```

## Patterns Used
- **InternalApiGuard**: restricts access to monitoring systems (validates internal API key or IP range)
- **Pull model**: Prometheus scrapes `/metrics` on schedule
- **OpenTelemetry**: standard trace format for compatibility with multiple backends
- **No tenant isolation needed**: this is a platform-level service, not tenant-scoped

## Inter-Service Communication
Calls other services (in pull model):
- Pulls metrics from each backend service's `/metrics` endpoint
- Reads NATS JetStream consumer lag metrics

Receives pushes (in push model):
- Other services may push metrics to observability-service via REST

## Key Dependencies
- `prom-client` - Prometheus client library for Node.js
- `@opentelemetry/sdk-node` - OpenTelemetry SDK
- `@opentelemetry/exporter-jaeger` - Jaeger trace exporter
- No TypeORM (no database)

## Key Configuration (Environment Variables)
```
# Database - uses SEPARATE database 'aquaculture_observability'
DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD
DB_NAME=aquaculture_observability    # NOT the main aquaculture database!
DB_SSL, DB_POOL_SIZE

PROMETHEUS_ENABLED=true
METRICS_COLLECTION_INTERVAL=30000  # ms between metric collection
JAEGER_ENDPOINT=http://jaeger:14268/api/traces
INTERNAL_API_KEY=...               # Required by InternalApiGuard
PORT=3008 (or similar)
```

## Known Gotchas
- **Separate database** - observability-service uses `aquaculture_observability` database (not `aquaculture`). Config uses `DB_HOST`/`DB_PORT`/`DB_USERNAME`/`DB_PASSWORD`/`DB_NAME` prefix (not `DATABASE_*`)
- **TypeORM is used** - unlike what might be expected, observability-service DOES use TypeORM (with `autoLoadEntities: true`), suggesting some metrics or traces are persisted in DB
- **No NestJS Guard visible** - the `InternalApiGuard` file exists but is not shown in AppModule providers. It may be applied at controller level or is planned.
- **InternalApiGuard** - all endpoints protected; monitoring systems must present internal API key or be in allowed IP range
- **No GraphQL, no TypeORM** - purely REST-based infrastructure service
- **Ephemeral metrics** - no persistent storage in this service; Prometheus stores time series data itself
- **Service-to-service scraping** - if using pull model, each backend service must expose a `/metrics` endpoint (typically via `prom-client` middleware)
- **Port conflict** - likely runs on a non-standard port (not 3000-3006 which are taken by other services)

## Related Services
- All backend services: source of metrics data
- Prometheus: scrapes `/metrics` endpoint
- Grafana: visualizes Prometheus data
- Jaeger/Zipkin: stores and queries distributed traces
- alert-engine: may use observability metrics to inform alert rules
