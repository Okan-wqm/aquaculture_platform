---
name: nginx-monitoring
description: Knowledge base for Nginx reverse proxy configuration and monitoring stack (Prometheus, Grafana, Loki) for the aquaculture platform
---

# Nginx & Monitoring Knowledge Base

## Overview

Nginx serves as the reverse proxy in production, routing traffic to backend (GraphQL/REST via gateway-api) and frontend (shell, microfrontends, mobile PWA) services. The monitoring stack uses Prometheus, Grafana, and Loki deployed via Helm values. Both are configured for the `aquaculture` Kubernetes namespace.

## Directory Structure

```
nginx/
  nginx.conf                   # Production nginx config (mounted in docker-compose.prod.yml)

infrastructure/docker/nginx/
  nginx.conf                   # Alternate nginx config for docker-based backend containers
  nginx.prod.conf              # Production-hardened config variant
  shell.conf                   # Nginx config for the shell (host app) container
  aquamobil.conf               # Nginx config for the AquaMobil PWA container
  microfrontend.conf           # Generic nginx config for MFE containers
  default.conf.template        # Dynamic config template with env var substitution

infrastructure/monitoring/
  prometheus/
    aquaculture-rules.yaml     # Custom PrometheusRule CRD with alerting rules
    prometheus-values.yaml     # Helm values for Prometheus Operator
  grafana/
    dashboards/
      aquaculture-overview.json # Pre-built Grafana dashboard JSON
  loki/
    loki-values.yaml           # Helm values for Loki log aggregation
  README.md
```

## Key Files & Configurations

### nginx/nginx.conf (Production)

The main nginx config mounted at `/etc/nginx/nginx.conf` on the nginx container in `docker-compose.prod.yml`.

**Upstreams**:
```nginx
upstream gateway    { server gateway-api:3000; keepalive 32; }
upstream shell      { server shell:80; }
upstream aquamobil  { server aquamobil:80; }
upstream dashboard  { server dashboard:80; }
upstream farm-module { server farm-module:80; }
upstream hr-module  { server hr-module:80; }
upstream sensor-module { server sensor-module:80; }
upstream admin-panel { server admin-panel:80; }
upstream tenant-admin { server tenant-admin:80; }
```

`keepalive 32` on the gateway upstream maintains persistent connections, reducing overhead for the high-frequency GraphQL traffic.

**Primary server block (port 80)**:

| Path | Upstream | Notes |
|------|----------|-------|
| `/health` | inline | Returns 200 OK, no logging |
| `/.well-known/acme-challenge/` | `/var/www/certbot` | Let's Encrypt ACME |
| `/graphql` | gateway | WebSocket support for subscriptions (`Upgrade: $http_upgrade`) |
| `/api/` | gateway | REST API pass-through |
| `/mobile/` | aquamobil | Trailing slash strips `/mobile` prefix |
| `/mf/dashboard/` | dashboard | Microfrontend path |
| `/mf/farm/` | farm-module | Microfrontend path |
| `/mf/hr/` | hr-module | Microfrontend path |
| `/mf/sensor/` | sensor-module | Microfrontend path |
| `/mf/admin/` | admin-panel | Microfrontend path |
| `/mf/tenant/` | tenant-admin | Microfrontend path |
| `/` | shell | Catch-all, passes through to shell |

**Security headers on all responses**:
```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
server_tokens off;
```

**WebSocket support for GraphQL subscriptions**:
```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```
Both headers are needed for WebSocket upgrade when clients use `graphql-ws`.

**Mobile subdomain** (second server block):
```nginx
server {
  server_name m.* mobile.*;  # Matches m.domain.com or mobile.domain.com
  # Routes /graphql → gateway, / → aquamobil
}
```

**Proxy timeouts**: 60s connect/send/read for all proxy locations.

**Certbot integration**: `/var/www/certbot` volume serves ACME challenges for Let's Encrypt renewal.

### Prometheus Rules (aquaculture-rules.yaml)

Custom `PrometheusRule` CRD in namespace `aquaculture`, labeled for `kube-prometheus` stack:

**Rule Groups**:

1. **aquaculture.service.health**:
   - `ServiceDown`: `up{namespace="aquaculture"} == 0` for 1m → critical
   - `HighErrorRate`: 5xx rate > 5% for 5m → warning
   - `CriticalErrorRate`: 5xx rate > 10% for 2m → critical

2. **aquaculture.performance**:
   - `HighLatency`: p95 > 2s for 5m → warning
   - `CriticalLatency`: p99 > 5s for 2m → critical

3. **aquaculture.resources**:
   - `HighCPUUsage`: container CPU > 80% of limit for 10m → warning
   - `HighMemoryUsage`: container memory > 85% of limit for 10m → warning
   - `PodRestarting`: > 3 restarts in 1h → warning

4. **aquaculture.sensors**:
   - `SensorDataIngestionLag`: No new sensor data for >5min by sensor_type → warning
   - `HighSensorErrorRate`: > 10 errors/sec by sensor_type → warning

5. **aquaculture.database**:
   - `DatabaseConnectionPoolExhausted`: pg connections > 90% of max → critical
   - `SlowQueries`: avg query time > 1s → warning

6. **aquaculture.alerts**:
   - `AlertProcessingDelay`: p95 alert processing > 30s → warning
   - `UnacknowledgedCriticalAlerts`: > 5 open critical alerts for 15m → critical

### Prometheus Values (prometheus-values.yaml)

Helm values for `kube-prometheus-stack`. Key settings:
- Scrape interval: 30s (set in `metrics.serviceMonitor.interval` in Helm chart)
- ServiceMonitor selector: labels matching `aquaculture` namespace

### Loki Values (loki-values.yaml)

Log aggregation for all pod logs. Likely configured with:
- Promtail as DaemonSet log collector
- Loki as log store
- Grafana as query frontend

### Grafana Dashboard (aquaculture-overview.json)

Pre-built overview dashboard covering:
- Service health (up/down status)
- Request rates and error rates
- Latency percentiles
- Sensor data ingestion rates
- Database connection pool utilization
- Alert counts by severity

## Dependencies / Integrations

- **Docker Compose**: nginx container in `docker-compose.prod.yml` mounts `nginx/nginx.conf` and `nginx/ssl/` for TLS certs
- **certbot**: ACME challenge path `/var/www/certbot` for Let's Encrypt cert renewal
- **Kubernetes**: The PrometheusRule CRD requires Prometheus Operator to be installed
- **Helm**: `metrics.serviceMonitor.enabled: true` in the Helm chart creates ServiceMonitor resources
- **gateway-api**: All API traffic routes through gateway. nginx must resolve `gateway-api` by Docker service name or K8s service name
- **shell + microfrontends**: All frontend services must be running and resolvable for nginx upstreams

## Known Gotchas

1. **`/mobile/` trailing slash strips the path prefix** - `proxy_pass http://aquamobil/;` (with trailing slash) strips `/mobile` from the upstream request. The PWA at `/mobile/page` becomes `/page` at the upstream. Ensure the PWA is built with the correct base path.

2. **WebSocket upgrade headers must be set before GraphQL subscriptions work** - Without `Upgrade: $http_upgrade` and `Connection: upgrade`, the WebSocket handshake fails silently.

3. **nginx container on `aqua-network` only** - In `docker-compose.prod.yml`, nginx is on `aqua-network` (external). All backend services are on `aqua-internal` (internal). nginx must be on both to proxy to backend services AND to be accessible from outside. The current config has nginx only on `aqua-network`, meaning it cannot resolve `gateway-api` by name. The gateway service needs to be on `aqua-network` too, which it is.

4. **PrometheusRule requires Prometheus Operator** - The CRD `PrometheusRule` is only recognized if `kube-prometheus-stack` is installed. Without it, the YAML applies to K8s but has no effect.

5. **`sensor_reading_timestamp` metric** - The sensor ingestion lag alert uses `sensor_reading_timestamp` as a metric label. This must be exported as a Prometheus metric by the sensor-service. If not implemented, the alert never fires.

6. **SSL cert volume** - The nginx in `docker-compose.prod.yml` mounts `./nginx/ssl:/etc/nginx/ssl:ro`. This directory must contain valid TLS certs. Use certbot with the ACME challenge path to obtain them, or provide self-signed certs.

7. **`server_tokens off`** - Hides nginx version from responses. This is a basic security hardening measure already applied.

8. **No rate limiting configured** - The nginx config does not include `limit_req_zone` or `limit_conn_zone`. Rate limiting is handled at the gateway-api level (`apps/gateway-api/src/config/rate-limit.config.ts`).

9. **Grafana dashboard JSON** - The pre-built dashboard in `aquaculture-overview.json` must be imported into Grafana. It is not automatically provisioned unless Grafana is configured with the dashboard provisioning sidecar.
