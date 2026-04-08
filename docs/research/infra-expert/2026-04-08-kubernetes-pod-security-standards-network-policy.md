# Research: Kubernetes Production Hardening — Pod Security Standards, NetworkPolicy, External Secrets

**Topic:** Kubernetes workload hardening — Pod Security Standards (Baseline/Restricted), resource requests+limits, liveness/readiness/startup probes, PodDisruptionBudget, NetworkPolicy east-west traffic, external-secrets-operator, HPA, no `latest` tags.
**Date:** 2026-04-08
**Agent:** infra-expert

## Sources
- [kubernetes.io: Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [kubernetes.io: Pod Security Admission](https://kubernetes.io/docs/concepts/security/pod-security-admission/)
- [kubernetes.io: Configure Liveness, Readiness and Startup Probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [kubernetes.io: Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [kubernetes.io: PodDisruptionBudget](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)
- [kubernetes.io: Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [kubernetes.io: Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [external-secrets.io: External Secrets Operator](https://external-secrets.io/)
- [OWASP Kubernetes Top 10](https://owasp.org/www-project-kubernetes-top-ten/)
- [CIS Kubernetes Benchmark (cisecurity.org)](https://www.cisecurity.org/benchmark/kubernetes)
- [NSA/CISA Kubernetes Hardening Guide v1.2](https://media.defense.gov/2022/Aug/29/2003066362/-1/-1/0/CTR_KUBERNETES_HARDENING_GUIDANCE_1.2_20220829.PDF)

## Key Findings

1. **Pod Security Admission with `restricted` enforcement.** PSS replaced the deprecated PodSecurityPolicy in K8s 1.25. Every production namespace MUST carry labels:
   ```yaml
   labels:
     pod-security.kubernetes.io/enforce: restricted
     pod-security.kubernetes.io/enforce-version: v1.35
     pod-security.kubernetes.io/audit: restricted
     pod-security.kubernetes.io/warn: restricted
   ```
   Namespaces without PSS labels default to `privileged` = CRITICAL.

2. **Restricted profile requirements (beyond Baseline).** Every container in a restricted namespace MUST:
   - `allowPrivilegeEscalation: false`
   - `capabilities: { drop: [ALL] }` (add only what is needed, e.g., `NET_BIND_SERVICE`)
   - `runAsNonRoot: true`, `runAsUser: <non-zero>` (use 1000+)
   - `readOnlyRootFilesystem: true` (mount `emptyDir` for `/tmp`, `/app/cache`)
   - `seccompProfile: { type: RuntimeDefault }`
   - No `hostNetwork`, `hostPID`, `hostIPC`, `hostPath`, `privileged: true`

3. **Resource requests AND limits on EVERY container.** Missing requests → scheduler can't place pods correctly, noisy neighbors starve critical workloads. Missing limits → a bug can OOM the node. Pattern:
   ```yaml
   resources:
     requests:
       cpu: 100m
       memory: 256Mi
     limits:
       cpu: 1000m
       memory: 1Gi
   ```
   Requests ≈ P50 usage, limits ≈ P99+headroom. CPU limit is controversial (can cause throttling); memory limit is mandatory (OOMKill is deterministic). Missing memory limit = CRITICAL. Missing requests = HIGH.

4. **Liveness / readiness / startup probes.** Three distinct roles:
   - **Readiness:** "Am I ready to receive traffic?" → gates Service endpoint membership. Missing = broken rolling updates (traffic to not-ready pods).
   - **Liveness:** "Am I alive or deadlocked?" → triggers pod restart. Too aggressive = restart loop during load; too slow = deadlock persists.
   - **Startup:** "Have I finished initializing?" → delays liveness/readiness kicks for slow-starting apps (NestJS can take 30-60s with heavy DI). Missing startup probe on slow-starting app = restart loop.
   
   All three MUST be present for critical services. Probe endpoint MUST be lightweight (`/health/live`, `/health/ready`) — NOT `/` which runs full app stack.

5. **PodDisruptionBudget for critical services.**
   ```yaml
   apiVersion: policy/v1
   kind: PodDisruptionBudget
   spec:
     minAvailable: 2  # or maxUnavailable: 1
     selector:
       matchLabels: { app: auth-service }
   ```
   Without PDB, voluntary disruptions (node drain, cluster autoscaler scale-down) can evict all replicas simultaneously = outage. Required for any replicas ≥ 2.

6. **NetworkPolicy for east-west traffic.** Default K8s = flat network, every pod can reach every pod. This is CRITICAL in multi-tenant or defense-in-depth contexts. Best practice:
   - Default-deny ingress + egress per namespace
   - Allow rules per service declaring required peers
   - Explicit DNS egress (`kube-dns` on 53 UDP/TCP)
   - Example:
     ```yaml
     apiVersion: networking.k8s.io/v1
     kind: NetworkPolicy
     metadata: { name: default-deny, namespace: prod }
     spec:
       podSelector: {}
       policyTypes: [Ingress, Egress]
     ```
   Missing NetworkPolicy in production namespace = HIGH.

7. **External Secrets Operator, not ConfigMap or inline Secret.** Kubernetes Secrets are base64, not encrypted at rest unless etcd encryption is enabled. Better pattern:
   - ESO syncs from AWS Secrets Manager / HashiCorp Vault / GCP Secret Manager / Azure Key Vault
   - `ExternalSecret` CRD declares which keys to sync
   - Automatic rotation from source
   - Secrets in Git (even encrypted) = HIGH risk (SealedSecrets is OK if the key is escrow'd)
   Secrets stored in ConfigMap = CRITICAL. Secrets in plain YAML in Git = CRITICAL.

8. **HorizontalPodAutoscaler for stateless services.**
   ```yaml
   apiVersion: autoscaling/v2
   kind: HorizontalPodAutoscaler
   spec:
     minReplicas: 2
     maxReplicas: 20
     metrics:
       - type: Resource
         resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }
       - type: Resource
         resource: { name: memory, target: { type: Utilization, averageUtilization: 80 } }
   ```
   HPA requires `metrics-server` and container `resources.requests` defined. Missing HPA on user-facing services = MEDIUM.

9. **Image tags MUST be immutable.** `latest` or floating tags (`:prod`) = CRITICAL (rollback impossible, rolling update non-deterministic). Use `image:v1.2.3@sha256:...` or at minimum semver tag with `imagePullPolicy: IfNotPresent`. `imagePullPolicy: Always` + `latest` is the worst combination.

10. **ServiceAccount per workload.** Default SA has auto-mounted token (old default) and broad permissions. Create dedicated SA per workload, set `automountServiceAccountToken: false` unless the pod talks to the API server, and RBAC only the needed verbs.

11. **Topology spread constraints.** Prevent all replicas landing on the same node/AZ:
    ```yaml
    topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels: { app: api }
    ```

12. **Graceful shutdown: `terminationGracePeriodSeconds` + `preStop` hook.** Default 30s is often too short for connection drain + outbox flush. NestJS `app.enableShutdownHooks()` + K8s 60-90s grace is standard.

## Security Concerns
- Namespace without Pod Security Admission labels = CRITICAL.
- Container with `runAsUser: 0` or missing `runAsNonRoot: true` in production = CRITICAL.
- Missing `drop: [ALL]` on capabilities = HIGH.
- Missing `allowPrivilegeEscalation: false` = HIGH.
- `readOnlyRootFilesystem: false` (default) = MEDIUM → HIGH in prod.
- Missing `seccompProfile: RuntimeDefault` = MEDIUM.
- Secrets stored in ConfigMap = CRITICAL.
- Secrets in plain YAML in Git = CRITICAL.
- Missing NetworkPolicy in production namespace = HIGH.
- Pod using default ServiceAccount with auto-mounted token = MEDIUM.
- `hostNetwork: true`, `hostPID: true`, `hostPath` volumes in app pods = CRITICAL.
- `latest` image tag or floating tag = CRITICAL.
- Missing `imagePullSecrets` for private registry = HIGH (image pull fails).

## Performance / Reliability Concerns
- Missing memory limit = CRITICAL (node OOM).
- Missing resource requests = HIGH (scheduling anomalies).
- Missing liveness/readiness probes = HIGH.
- Missing startup probe on slow-start app (NestJS) = MEDIUM (false liveness failures).
- Missing PodDisruptionBudget on services with ≥2 replicas = HIGH.
- Missing HPA on user-facing stateless services = MEDIUM.
- Missing topology spread constraints across AZs = MEDIUM.
- `terminationGracePeriodSeconds` default 30s with in-flight work = MEDIUM.
- Probe endpoints running full middleware stack (DB queries) = HIGH (cascading failures during load).

## Architectural Implications for infra-expert reviews
- Every production namespace MUST carry PSS enforce=restricted labels.
- Every container MUST: request+limit both CPU and memory, run as non-root, drop ALL caps, readOnlyRootFilesystem, seccompProfile RuntimeDefault, all three probes.
- Every production namespace MUST have default-deny NetworkPolicy and explicit allow rules.
- Secrets MUST flow through ExternalSecrets, not inline YAML or ConfigMap.
- Every deployment with ≥2 replicas MUST have PDB.
- Every user-facing service MUST have HPA.
- No `latest` or floating image tags — ever.

## Domain Rule Additions for infra-expert

Add to `## Domain Rules → Kubernetes`:
- Every production namespace MUST carry `pod-security.kubernetes.io/enforce: restricted` labels; missing = CRITICAL.
- Every container MUST set `runAsNonRoot: true`, `runAsUser: <non-zero>`, `allowPrivilegeEscalation: false`, `capabilities: { drop: [ALL] }`, `readOnlyRootFilesystem: true`, `seccompProfile: { type: RuntimeDefault }`; missing each = HIGH.
- Every container MUST declare both `requests` and `limits` for CPU and memory; missing memory limit = CRITICAL, missing requests = HIGH.
- Every container MUST have readiness AND liveness probes; slow-start services MUST also have a startup probe; missing = HIGH.
- Probe endpoints MUST be lightweight (`/health/live`, `/health/ready`) and not execute heavy middleware; using `/` or running DB queries = HIGH.
- Every deployment with `replicas >= 2` MUST have a PodDisruptionBudget; missing = HIGH.
- Every production namespace MUST have a default-deny NetworkPolicy plus explicit allow rules for legitimate peers; missing = HIGH.
- Secrets MUST come from External Secrets Operator (AWS SM / Vault / GCP SM / Azure KV); secrets in ConfigMap or plain YAML = CRITICAL.
- `imagePullPolicy: Always` with `latest` or floating tag = CRITICAL; use semver + digest and `IfNotPresent`.
- Every workload MUST have a dedicated ServiceAccount with `automountServiceAccountToken: false` unless the pod calls the API server.
- User-facing stateless services MUST have HPA configured with CPU + memory metrics; missing = MEDIUM.
- Deployments SHOULD set `topologySpreadConstraints` across zones; missing = MEDIUM.
- `terminationGracePeriodSeconds` MUST be tuned to match in-flight work duration; default 30s with long-running requests = MEDIUM.
