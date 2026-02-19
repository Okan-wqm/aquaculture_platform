---
name: kubernetes
description: Knowledge base for Kubernetes - manifests, Kustomize overlays, and K8s resource configurations for the aquaculture platform
---

# Kubernetes Knowledge Base

## Overview

Kubernetes is the target orchestration platform for production-scale deployments. The setup uses Kustomize for configuration management with a base/overlay pattern supporting dev, staging, and production environments. This is an alternative to the current DigitalOcean droplet deployment (which uses Docker Compose).

## Directory Structure

```
infrastructure/kubernetes/
  base/
    kustomization.yaml       # Root Kustomize config listing all resources
    namespace.yaml           # aquaculture namespace
    configmap.yaml           # Shared config (DB URLs, service URLs, etc.)
    secrets.yaml             # Secret placeholders (overridden by overlays)
    rbac.yaml                # ServiceAccount, ClusterRole, ClusterRoleBinding
    gateway-api.yaml         # Deployment + Service + HPA + PDB
    auth-service.yaml        # Deployment + Service
    farm-service.yaml        # Deployment + Service
    sensor-service.yaml      # Deployment + Service + HPA
    alert-engine.yaml        # Deployment + Service
    notification-service.yaml
    shell.yaml               # Frontend shell Deployment + Service
    frontend-modules.yaml    # All microfrontend Deployments + Services
    ingress.yaml             # Nginx ingress with TLS
  overlays/
    dev/
      kustomization.yaml     # Dev overrides (lower replicas, dev images)
    staging/
      kustomization.yaml     # Staging overrides
    production/
      kustomization.yaml     # Production overrides (full replicas, prod images)
```

## Key Files & Configurations

### kustomization.yaml (Base)

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: aquaculture
resources:
  - namespace.yaml
  - configmap.yaml
  - secrets.yaml
  - rbac.yaml
  - gateway-api.yaml
  - auth-service.yaml
  - farm-service.yaml
  - sensor-service.yaml
  - alert-engine.yaml
  - notification-service.yaml
  - shell.yaml
  - frontend-modules.yaml
  - ingress.yaml
commonLabels:
  app.kubernetes.io/part-of: aquaculture-platform
  app.kubernetes.io/managed-by: kustomize
images:
  - name: ghcr.io/aquaculture/gateway-api
    newTag: latest
  # ... all services
```

### Gateway API Manifest (gateway-api.yaml)

The most complex manifest, serving as the reference pattern:

**Deployment**:
- `replicas: 3`
- Image: `ghcr.io/aquaculture/gateway-api:latest`
- Resources: `requests: {cpu: 250m, memory: 512Mi}`, `limits: {cpu: 1000m, memory: 1Gi}`
- Security: `runAsNonRoot: true`, `runAsUser: 1001`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`
- Probes: liveness on `/health`, readiness on `/health/ready` (port 3000)
- Prometheus annotations: `prometheus.io/scrape: "true"`, `prometheus.io/port: "3000"`, `prometheus.io/path: "/metrics"`
- Pod anti-affinity: prefer spreading across nodes

**HPA (HorizontalPodAutoscaler)**:
- `minReplicas: 3`, `maxReplicas: 10`
- CPU target: 70%, Memory target: 80%
- API version: `autoscaling/v2`

**PDB (PodDisruptionBudget)**:
- `minAvailable: 2` (ensures rolling updates don't break service)

**Service**: ClusterIP, port 80 → 3000

### Resource Profiles by Service

| Service | Replicas | CPU Req | Mem Req | HPA |
|---------|----------|---------|---------|-----|
| gateway-api | 3 | 250m | 512Mi | 3-10 |
| auth-service | 2 | 100m | 256Mi | No |
| farm-service | 2 | 100m | 256Mi | No |
| sensor-service | 3 | 250m | 512Mi | 3-15 |
| alert-engine | 2 | 100m | 256Mi | No |
| billing-service | 2 | 100m | 256Mi | No |
| hr-service | 2 | 100m | 256Mi | No |
| notification-service | 2 | 100m | 256Mi | No |
| shell (frontend) | 2 | 50m | 64Mi | No |
| dashboard | 2 | 50m | 64Mi | No |

### RBAC (rbac.yaml)

Service account `aquaculture-sa` with permissions to read ConfigMaps and Secrets within the `aquaculture` namespace. Used by all deployments via `serviceAccountName: aquaculture-sa`.

### Ingress (ingress.yaml)

Uses nginx ingress controller:
- `app.aquaculture.io/` → `shell` service
- `api.aquaculture.io/` → `gateway-api` service
- TLS via cert-manager with `letsencrypt-prod` ClusterIssuer
- Annotations: `ssl-redirect: "true"`, `proxy-body-size: "50m"`

### ConfigMap Pattern

All services load environment variables from:
```yaml
envFrom:
  - configMapRef:
      name: aquaculture-config
  - secretRef:
      name: aquaculture-secrets
```

The configmap contains non-sensitive config; secrets contain DB URLs, JWT secret, Redis password.

### Overlay Pattern

Each overlay's `kustomization.yaml` extends base with:
```yaml
bases:
  - ../../base
patchesStrategicMerge:
  - replicas-patch.yaml    # Override replica counts
images:
  - name: ghcr.io/aquaculture/gateway-api
    newTag: sha-abc123     # Pin to specific commit SHA
```

## Dependencies / Integrations

- **Terraform**: EKS cluster provisioned via Terraform. K8s provider configured with EKS endpoint from Terraform outputs.
- **Helm**: Alternative to Kustomize. The `infrastructure/helm/aquaculture/` chart covers the same services.
- **Prometheus**: ServiceMonitor resources would be added for monitoring. Gateway pods annotated for scraping.
- **cert-manager**: Required for TLS certificate management via `letsencrypt-prod` ClusterIssuer.
- **nginx ingress controller**: Required for the Ingress resources to function.

## Known Gotchas

1. **`readOnlyRootFilesystem: true`** - Deployments require this security context. Services that write to disk (logs, temp files) need an `emptyDir` volume mount. The Node.js services run from `/app` which is read-only, but `/tmp` should be available.

2. **Service account for IRSA** - If services need AWS resource access (S3/Secrets Manager), add IRSA annotations to `aquaculture-sa`. The Terraform EKS module sets up the OIDC provider for this.

3. **Image tags in base use `latest`** - The `kustomization.yaml` images section overrides tags per overlay. Always override to a specific SHA in production overlays, never deploy `latest` to production.

4. **Namespace `aquaculture`** - All resources are in this namespace. The `namespace.yaml` creates it. Helm chart uses the same namespace.

5. **HPA requires metrics-server** - The cluster must have `metrics-server` installed for CPU/memory-based HPA to function.

6. **PDB blocks cluster upgrades** - The gateway-api PDB with `minAvailable: 2` on 3 replicas means only 1 pod can be evicted at a time during node drains. Plan upgrades accordingly.

7. **Sensor-service HPA max 15** - Sensor service can scale significantly higher than other services because it handles high-frequency MQTT/sensor data ingestion.
