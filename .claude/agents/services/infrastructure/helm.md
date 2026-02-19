---
name: helm
description: Knowledge base for Helm - chart structure, values, and templates for the aquaculture platform Kubernetes deployment
---

# Helm Knowledge Base

## Overview

The Helm chart at `infrastructure/helm/aquaculture/` provides a Kubernetes deployment alternative to the Kustomize approach. It wraps all platform services (backend + frontend) into a single deployable chart with infrastructure dependencies managed via sub-charts (Bitnami PostgreSQL/Redis, NATS).

## Directory Structure

```
infrastructure/helm/aquaculture/
  Chart.yaml                     # Chart metadata and dependencies
  values.yaml                    # Default values (all services, resources, scaling)
  templates/
    _helpers.tpl                 # Template helpers (name, labels, annotations)
    secrets.yaml                 # Secret resource from values
    gateway-api.yaml             # Deployment + Service + HPA for gateway
    backend-services.yaml        # All backend Deployments + Services
    frontend-services.yaml       # All frontend Deployments + Services
    ingress.yaml                 # Ingress with TLS
    serviceaccount.yaml          # ServiceAccount
```

## Key Files & Configurations

### Chart.yaml

```yaml
apiVersion: v2
name: aquaculture
description: Multi-tenant aquaculture management system
type: application
version: 1.0.0
appVersion: "1.0.0"
keywords: [aquaculture, microservices, multi-tenant, iot, sensors]

dependencies:
  - name: postgresql
    version: "13.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: postgresql.enabled
  - name: redis
    version: "18.x.x"
    repository: "https://charts.bitnami.com/bitnami"
    condition: redis.enabled
  - name: nats
    version: "1.x.x"
    repository: "https://nats-io.github.io/k8s/helm/charts/"
    condition: nats.enabled
```

All infrastructure dependencies are conditional via `postgresql.enabled`, `redis.enabled`, `nats.enabled`. Can be disabled when using external managed services (AWS RDS, ElastiCache).

### values.yaml - Backend Services

Resource profiles pattern:

```yaml
gatewayApi:
  enabled: true
  replicaCount: 3
  image:
    repository: aquaculture/gateway-api
    tag: latest
    pullPolicy: Always
  service:
    type: ClusterIP
    port: 80
    targetPort: 3000
  resources:
    requests: { cpu: 250m, memory: 512Mi }
    limits:   { cpu: 1000m, memory: 1Gi }
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 10
    targetCPUUtilizationPercentage: 70
  env:
    NODE_ENV: production
    PORT: "3000"

# Pattern for most other backend services:
authService:
  replicaCount: 2
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits:   { cpu: 500m, memory: 512Mi }

# Sensor gets higher replicas + autoscaling:
sensorService:
  replicaCount: 3
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 15
    targetCPUUtilizationPercentage: 60
```

### values.yaml - Frontend Services

All frontends are lightweight nginx containers:

```yaml
shell:
  replicaCount: 2
  service: { type: ClusterIP, port: 80, targetPort: 80 }
  resources:
    requests: { cpu: 50m, memory: 64Mi }
    limits:   { cpu: 200m, memory: 128Mi }

# Same pattern for: dashboard, farmModule, processEditor, adminPanel
```

### values.yaml - Ingress

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: app.aquaculture.io
      paths:
        - { path: /, pathType: Prefix, service: shell }
    - host: api.aquaculture.io
      paths:
        - { path: /, pathType: Prefix, service: gateway-api }
  tls:
    - secretName: aquaculture-tls
      hosts: [app.aquaculture.io, api.aquaculture.io]
```

### values.yaml - Security

```yaml
serviceAccount:
  create: true
  name: aquaculture-sa

podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1001
  fsGroup: 1001

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true

networkPolicy:
  enabled: true
```

### values.yaml - Infrastructure Sub-charts

```yaml
postgresql:
  enabled: true
  auth:
    username: aquaculture
    password: ""          # Must be overridden
    database: aquaculture
  primary:
    persistence:
      size: 20Gi

redis:
  enabled: true
  auth:
    password: ""          # Must be overridden
  master:
    persistence:
      size: 5Gi

nats:
  enabled: true
  config:
    jetstream:
      enabled: true
      memStorage:   { size: 1Gi }
      fileStorage:  { enabled: true, size: 5Gi }
```

### values.yaml - Monitoring

```yaml
metrics:
  enabled: true
  serviceMonitor:
    enabled: true
    interval: 30s
```

Creates ServiceMonitor CRDs for Prometheus Operator.

### values.yaml - External Secrets

```yaml
externalSecrets:
  enabled: false
  secretStore:
    name: ""
    kind: ClusterSecretStore
```

Disabled by default; can be enabled to pull secrets from AWS Secrets Manager or HashiCorp Vault.

### Liveness / Readiness Probe Defaults

```yaml
livenessProbe:
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3

readinessProbe:
  initialDelaySeconds: 10
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3
```

## Dependencies / Integrations

- **Terraform**: Helm provider in `infrastructure/terraform/environments/production/main.tf` deploys this chart after EKS provisioning
- **Kustomize**: Alternative to Helm; both cover the same services. Kustomize approach in `infrastructure/kubernetes/`
- **cert-manager**: Required cluster addon for TLS; the chart references `letsencrypt-prod` ClusterIssuer
- **nginx ingress controller**: Required for Ingress resources
- **Prometheus Operator**: Required for ServiceMonitor CRDs (`metrics.serviceMonitor.enabled`)

## Known Gotchas

1. **Image registry prefix** - `global.imageRegistry: ghcr.io` sets the prefix. Templates build full image path as `{global.imageRegistry}/{image.repository}:{image.tag}`.

2. **Sub-chart passwords cannot be empty in production** - `postgresql.auth.password: ""` and `redis.auth.password: ""` in `values.yaml` are placeholders. Always override via `--set` or a secrets values file: `helm upgrade --set postgresql.auth.password=secrethere`

3. **`postgresql.enabled: false` for AWS RDS** - When using the Terraform-provisioned RDS, disable the postgresql sub-chart and set the `secrets.databaseUrl` to the RDS endpoint.

4. **Chart version vs appVersion** - `version: 1.0.0` is the chart version; `appVersion: "1.0.0"` is the platform version. Bump chart version when values or templates change.

5. **`processEditor` in values** - Referenced in `values.yaml` but not in Kustomize base. This was a planned service (process flow editor). The frontend `processEditor` key may map to a future MFE.

6. **NetworkPolicy** - When `networkPolicy.enabled: true`, ensure your cluster CNI supports NetworkPolicy (Calico, Cilium, Weave). AWS VPC CNI does not support NetworkPolicy natively.

7. **`readOnlyRootFilesystem: true`** in securityContext - Same as Kubernetes manifests. Any service writing to local disk needs emptyDir volumes.

8. **Dependency update required** - Before first install, run `helm dependency update infrastructure/helm/aquaculture/` to download Bitnami/NATS sub-charts into `charts/`.
