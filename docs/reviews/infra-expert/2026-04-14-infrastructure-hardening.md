# Infrastructure Hardening Findings

**Date:** 2026-04-14
**Reviewer:** infra-expert (self-initiated on user request)
**Scope:** production reliability gaps surfaced during review of External Secrets Operator, NetworkPolicies, PodDisruptionBudget, VPA, DR/Backup, and GitOps posture across `infrastructure/`, `infra/`, `deploy/`, `.github/workflows/`, and `docker-compose.droplet.yml`.
**Decision:** **HARDEN** — no production-blocking defect; multiple tier-2/tier-3 gaps.

## Summary

| Severity | Count |
|---|---:|
| CRITICAL | 1 |
| HIGH | 4 |
| MEDIUM | 5 |
| LOW | 2 |
| PARKED | 6 |

## Fact Check vs. Original Review Comment

The original user-submitted review claimed six gaps. Three are already resolved, one is premature, and two are partially true. Evidence:

- **CLAIM "No External Secrets Operator"** — FALSE. `infrastructure/helm/aquaculture/templates/secrets.yaml:54-100` templates `ExternalSecret` CRDs. `values-production.yaml:105-111` binds to `aws-secrets-manager`. Runbook `docs/runbooks/secret-rotation.md` exists.
- **CLAIM "No NetworkPolicies"** — FALSE. 12 NetworkPolicy manifests across `infrastructure/helm/aquaculture/templates/networkpolicy.yaml` (10) and `infrastructure/kubernetes/base/rbac.yaml:265-365` (2). Default-deny + per-service allow for 8 backends + frontend tier.
- **CLAIM "No PDB"** — PARTIAL. All 7 backend services + gateway-api covered. Frontend services uncovered in Helm; `deploy/production/pdb.yaml` is orphan (details in INFRA-ORPHAN-001).
- **CLAIM "No VPA"** — TRUE but premature; requires a live cluster and ≥2 weeks of traffic data. Parked.
- **CLAIM "No DR/Backup"** — PARTIAL. RDS 30-day retention + multi-AZ exists, ElastiCache 7-day snapshots exist. Droplet-side gaps in scheduled backups + executed restore drill are real.
- **CLAIM "No GitOps"** — TRUE but premature; production target is docker-compose on a DigitalOcean droplet, not Kubernetes. ArgoCD bootstrap is gated on an EKS cluster.

---

## Findings

### INFRA-ORPHAN-001 — `deploy/production/pdb.yaml` protects nothing (MEDIUM)

The PDB in `deploy/production/pdb.yaml:10-23` uses selectors `app: backend` / `app: frontend`, which exist only in the monolith-style manifests under `deploy/base/` (Deployments literally named `backend` and `frontend`). The Helm chart — which is the production deployment source — uses per-service labels (`app: auth-service`, `app: sensor-service`, `app: shell`, …). The PDB therefore selects zero pods produced by any active deploy pipeline and creates false confidence.

**Evidence:**
- `deploy/production/pdb.yaml:11,23`
- `deploy/production/kustomization.yaml:9-12` (references pdb.yaml)
- `deploy/base/backend-deployment.yaml:5-6` (monolith `app: backend` label)
- `infrastructure/helm/aquaculture/templates/backend-services.yaml:24-25` (per-service `app: auth-service` label)

**Remediation:**
Delete the orphan PDB file and its reference from `deploy/production/kustomization.yaml`. Helm-owned PDBs remain the single source of truth for backend pod disruption protection. Dead kustomize monolith tree flagged separately (INFRA-TECHDEBT-001).

**Cross-domain:** none.

---

### INFRA-TECHDEBT-001 — Dead `deploy/base/` + `deploy/production/` monolith Kustomize tree (LOW, deferred)

`deploy/base/backend-deployment.yaml` and `deploy/base/frontend-deployment.yaml` define monolith `backend` / `frontend` Deployments that predate the per-service Helm chart. No enabled GitHub workflow targets them:
- `cd-production.yml` is `if: false` (line 54) and uses `kubectl set image` against per-service deployment names, not this tree.
- `cd-staging.yml` expects `deploy/staging/<service>-deployment.yaml` files (per-service) that don't exist.
- No other file references `deploy/base/` or `deploy/production/`.

**Remediation (future task):** remove `deploy/base/` and `deploy/production/` entirely once the narrower INFRA-ORPHAN-001 cleanup is merged. Wrap into a follow-up scoped PR to limit blast radius.

**Status:** DEFERRED-TECHDEBT (owner: infra-expert; re-raise when K8s migration plan lands).

---

### INFRA-PDB-001 — Helm chart has no PDB for frontend services (HIGH)

`infrastructure/helm/aquaculture/templates/frontend-services.yaml` defines Deployments + Services for shell, dashboard, farm-module, admin-panel, tenant-admin, hydroponics-module, process-editor — but no `PodDisruptionBudget` blocks. Node drains or rolling updates can violate minimum availability for all frontend microfrontends simultaneously.

**Evidence:**
- `infrastructure/helm/aquaculture/templates/frontend-services.yaml` (no `kind: PodDisruptionBudget`)
- Contrast with `backend-services.yaml:85-96` (pattern to copy)

**Remediation:**
Append `PodDisruptionBudget` blocks per enabled frontend service with `minAvailable: 1`, gated on `replicaCount > 1`.

**Cross-domain:** `frontend-expert` (for review of selector labels).

---

### INFRA-SECRETS-001 — Terraform `secrets-manager` module is 0-byte placeholder (HIGH)

`infra/terraform/modules/security/secrets-manager/{main,outputs,variables}.tf` are all 0 bytes. `values-production.yaml:105-111` expects secrets to already exist in AWS Secrets Manager, but Terraform never provisions them.

**Evidence:**
- `ls -la infra/terraform/modules/security/secrets-manager/` → all files size 0
- `infrastructure/helm/aquaculture/values-production.yaml:105-111`

**Remediation:**
Implement the three files: `variables.tf` (secret_names, kms_key_arn, rotation_days), `main.tf` (`aws_secretsmanager_secret` per name + `aws_secretsmanager_secret_rotation` + customer-managed KMS), `outputs.tf` (ARN map). Module must not be referenced from any environment until the EKS migration is active (gate behind `var.enable_eks`).

**Cross-domain:** `auth-security-expert` (secret-name list), `architect-review` (KMS key policy).

---

### INFRA-SECRETS-002 — `ClusterSecretStore` manifest missing from repo (HIGH)

`values-production.yaml:108` references `secretStore.name: aws-secrets-manager, kind: ClusterSecretStore` but no `kind: ClusterSecretStore` manifest exists anywhere in the repo. The Helm → ExternalSecret → ClusterSecretStore chain is therefore broken: an install would fail to resolve the target store.

**Evidence:**
- `grep -r "kind: ClusterSecretStore"` returns only value references, no CRD instance.
- `infrastructure/helm/aquaculture/templates/secrets.yaml:54-100`

**Remediation:**
New `infrastructure/kubernetes/base/cluster-secret-store.yaml` binding External Secrets Operator → AWS Secrets Manager via IRSA (no static AWS access keys). Standalone manifest; applied by Helm install or Kustomize base.

**Cross-domain:** `auth-security-expert`.

---

### INFRA-BACKUP-001 — No scheduled PostgreSQL backup on droplet (HIGH)

`tools/scripts/database/backup-databases.ts` exists but runs only when invoked manually. No cron, no offsite copy. RDS automated backups (30-day retention, multi-AZ) are configured only for the future EKS/RDS path, not the live droplet's local PostgreSQL container.

**Evidence:**
- `tools/scripts/database/backup-databases.ts` (manual invocation)
- `docker-compose.droplet.yml` (local PG container, no backup sidecar)
- `infrastructure/terraform/environments/production/main.tf:203-204` (RDS-only)

**Remediation:**
New `.github/workflows/backup-production.yml` — daily cron 03:00 UTC. SSH to droplet → run `backup-databases.ts` per service schema → upload to DigitalOcean Spaces with SSE + lifecycle (7d / 4w / 6m retention).

**Cross-domain:** `database-architect`.

---

### INFRA-BACKUP-002 — Restore path untested (HIGH)

No runbook describes how to restore from the backup artifacts produced by INFRA-BACKUP-001's workflow, and no drill has ever been executed. A backup without a verified restore is not a backup.

**Remediation:**
New `docs/runbooks/database-restore-drill.md` — quarterly procedure: spin ephemeral Postgres container, restore latest dump, run `SELECT COUNT(*)` across top-10 rows per table, log runtime + deltas. Execute once against staging as acceptance evidence.

**Cross-domain:** `database-architect`.

---

### INFRA-CRITICAL-001 — NATS JetStream single-node SPOF (CRITICAL)

`infrastructure/docker/nats/nats.conf:6-11` configures JetStream in single-node mode (R=1 default for streams). The droplet hosts exactly one NATS container. If that container crashes, all unacked JetStream messages on durable consumers and all stream state is lost.

**Evidence:**
- `infrastructure/docker/nats/nats.conf:6-11`
- `docker-compose.droplet.yml` (single `nats:` service)

**Remediation path (two options, separate plans):**
1. **EKS migration** — run NATS as a Helm subchart with `cluster.replicas=3, jetstream.enabled=true` (wired as INFRA-NATS-CLUSTER-001, shelf-ready today).
2. **Multi-droplet cluster** — provision two additional droplets, form NATS cluster over mTLS, gate behind new services.yaml entries. Separate plan if K8s slips > 6 months.

**Status:** OPEN, gated on K8s migration decision. Tracked as INFRA-CRITICAL-001; Track B shelf-ready work prepares option 1.

**Cross-domain:** `messaging-expert`, `architect-review`.

---

### INFRA-NATS-CLUSTER-001 — No NATS R=3 subchart dependency in Helm (MEDIUM)

`infrastructure/helm/aquaculture/Chart.yaml` does not depend on the upstream `nats` chart. Once the EKS cluster is live, operators would need to install NATS as a separate Helm release rather than an aquaculture-chart dependency.

**Remediation:**
Add `nats` as a Helm dependency (pinned version, `condition: nats.enabled`). Default `nats.enabled: false` so today's renders stay byte-identical. `values-production.yaml` overrides `cluster.replicas=3, jetstream.enabled=true` when enabling.

**Resolves:** pathway for INFRA-CRITICAL-001 option 1.

---

### INFRA-ARGOCD-001 — `infra/argocd/projects/aquaculture-platform.yaml` is 0-byte placeholder (MEDIUM)

GitOps bootstrapping requires at minimum an `AppProject` + `Application` declaration per environment. Current state: one 0-byte file. Any attempt to `argocd apply` would produce nothing.

**Remediation:**
Fill `aquaculture-platform.yaml` with a real `AppProject` (destination allow-list restricted to `aquaculture`, `aquaculture-system`, `monitoring` namespaces). Add `infra/argocd/applications/{production,staging}/aquaculture.yaml` `Application` manifests referencing the Helm chart + values files, with `syncPolicy.automated.{prune,selfHeal}: true` and `retry.limit: 3`.

**Status:** SHELF-READY (no effect until ArgoCD installed on a real cluster — see INFRA-C4).

---

### INFRA-CI-001 — No `helm lint` / `kubeconform` in CI (MEDIUM)

`.github/workflows/` has `infra-terraform-plan.yml` + `infra-terraform-drift.yml` but no validation for Helm chart rendering or Kubernetes manifest schema conformance. Any Track B change could introduce broken YAML undetected until someone runs `helm install` against a live cluster.

**Remediation:**
New `.github/workflows/infra-helm-lint.yml` — on PRs touching `infrastructure/helm/**` or `infrastructure/kubernetes/**`:
- `helm dependency update`
- `helm lint infrastructure/helm/aquaculture`
- `helm template … -f values-production.yaml | kubeconform -strict -ignore-missing-schemas`
- `helm template … -f values-staging.yaml | kubeconform -strict -ignore-missing-schemas`

Must be added BEFORE other Track B manifest work to catch regressions in the same PR they're introduced.

---

### INFRA-REDIS-001 — Redis persistence flags unverified on droplet (MEDIUM)

`docker-compose.droplet.yml` Redis service block has not been audited for combined AOF + RDB persistence. A restart between RDB snapshots on a non-persistent Redis loses all intermediate writes (including outbox draining state, rate-limit counters, session tokens).

**Remediation:**
Ensure Redis service `command:` includes `--appendonly yes --appendfsync everysec --save 900 1 --save 300 10` and mounts a named volume for `/data`. Add any missing flags.

---

### INFRA-ROTATION-001 — Secret rotation cadence not documented (MEDIUM)

`docs/runbooks/secret-rotation.md` describes rotation procedures but has no cadence table. Without an explicit rotation schedule, secrets drift to "rotate never" by default.

**Remediation:**
Append "Rotation Cadence" section: JWT keypair 90d, Stripe webhook 90d, password pepper 180d, DB password 90d. Add `.github/workflows/secret-rotation-reminder.yml` — monthly cron that opens a GitHub issue 14 days before each next-due rotation.

---

### INFRA-BACKUP-003 — K8s-native CronJob for PG backups missing (LOW)

Parallel to INFRA-BACKUP-001's GitHub-Actions-driven backup, the future K8s deployment needs a `CronJob` resource wrapping the same backup logic. Today's GHA workflow is the right answer for the droplet path; the K8s CronJob replaces it once migration completes.

**Remediation:**
New `infrastructure/kubernetes/base/jobs/pg-backup-cronjob.yaml` — shelf-ready manifest, no cluster impact until migration.

---

## Parked Findings (Awaiting EKS Cluster)

These gaps are real but not actionable without a provisioned Kubernetes cluster. They are raised here for audit trail only.

- **INFRA-C1** — Provision EKS cluster. Separate ADR + plan; involves AWS account decisions, networking, IAM design.
- **INFRA-C2** — VPA in recommendation mode (Goldilocks or KRR). Requires cluster + metrics-server + ≥2 weeks traffic data.
- **INFRA-C3** — Velero cluster-state backup. Requires cluster.
- **INFRA-C4** — ArgoCD install. Manifests prepared by INFRA-ARGOCD-001 sit on the shelf until then.
- **INFRA-C5** — Cross-region RDS snapshot replication. Premature for current scale; fold into DR maturity review post-migration.
- **INFRA-C6** — Enable `cd-production.yml`. Remains `if: false` until cluster exists.

Status for all: PARKED-AWAITING-CLUSTER.

---

## Execution Sequencing

Implementation plan (work packages + finding closures) is tracked in `/root/.claude/plans/cozy-hugging-tulip.md`. Each commit in this initiative will close one or more of the finding IDs above via the `Closes:` trailer.
