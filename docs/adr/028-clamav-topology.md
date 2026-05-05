# ADR-028: ClamAV Topology — Shared Deployment + ClusterIP Service

**Status:** Accepted (Scope B Phase V1 — 2026-04-26)
**Date:** 2026-04-26
**Deciders:** Okan (platform owner) + storage/security maintainers
**Owner:** Okan
**Deadline:** Phase V2 cutover (target Q3 2026) — once the Deployment lands and Phase V3 wires the scan worker, this ADR is promoted to **Accepted-and-Realised**.
**Related ADRs:** ADR-016 (deploy-resilience-architecture), ADR-024 (compliance-retention-matrix)
**Related plans:** `docs/plans/2026-04-24-deferred-items/scope-b-infrastructure.md` Scope 3 (Phase 6.2.2 ClamAV async virus scan)

---

## Context (WHY)

Scope B Phase V0 (PR #160) closed the prerequisite that every upload byte from the gateway-api flows through `FileUploadSecurityService.uploadSecure()` instead of calling MinIO directly. That wrapper now runs size + mime + magic-byte gates and (where applicable) strips EXIF metadata. What it does **NOT** do today is a content-level malware scan.

The plan's Phase V3 introduces ClamAV as the scan engine and an outbox-driven async worker that:

1. Receives a `StorageObjectUploadedEvent` after the upload commits.
2. Streams the object through `clamd` via the `clamscan` Node client.
3. Emits `FileScannedClean` (tag the object) or `FileInfected` (move to quarantine bucket + notify) per result.

Before any of that wiring lands, a deployment-shape decision has to be made: where does `clamd` actually run? The choice has cascading implications on resource cost, signature-DB freshness, scan latency, deploy complexity, and the surface area of fail-closed enforcement.

This ADR fixes the topology so PR-21 (Phase V2 K8s + docker-compose) and PR-22 (Phase V3 client + worker) reference one decision instead of relitigating it per PR.

### Operational constraints to satisfy

The decision MUST satisfy these constraints documented during the V1 investigation:

1. **Resource cost.** ClamAV's signature DB is ~250 MB at rest, ~600 MB resident in `clamd`'s memory map. Total per-process RAM (DB + scan workers + glibc overhead) is typically 1–1.5 GB. Multiplying that by every farm-service / admin-api pod is a non-trivial fleet cost.
2. **Signature freshness.** `freshclam` updates need to land within 24h of release for the scan to be meaningful (CVE-tracking malware families). Per-pod sidecars all run their own `freshclam` cron — at fleet scale that's many bandwidth-redundant fetches with no shared cache.
3. **Scan latency.** p99 scan must stay under 5 s for files in the policy size range (5–20 MB). Cold-start adds make the SLO harder to hit.
4. **Cost-per-scan stability.** Volume is steady (operator-driven uploads, not consumer-driven). A pay-per-invocation model would charge for the steady baseline rather than the bursts.
5. **Fail-closed posture.** Phase V4 enforces "if `clamd` is unhealthy, uploads return 503". That requires a clearly named dependency the upload controller's preflight can probe.
6. **Deploy resilience.** ADR-016 requires graceful degradation under partial failure — losing one ClamAV instance should not cap the whole upload pipeline.

---

## Decision (WHAT)

**ClamAV runs as a shared `Deployment` (2 replicas) behind a `ClusterIP` Service in each cluster.** The service name is `clamav`; the port is `3310` (clamd TCP). All scan clients (the upcoming `ClamAVClientService` in `libs/storage`) reach it via `clamav.<namespace>.svc.cluster.local:3310`. A single shared `freshclam` schedule (CronJob + sidecar `freshclam --daemon`) updates the signature DB every 6 hours; staleness > 24 h pages on-call (per Phase V6 alert rules).

```yaml
# infrastructure/kubernetes/base/clamav.yaml — Phase V2 will materialise
apiVersion: apps/v1
kind: Deployment
metadata:
  name: clamav
spec:
  replicas: 2          # HA without overprovisioning
  selector:
    matchLabels:
      app: clamav
  template:
    spec:
      containers:
      - name: clamd
        image: clamav/clamav:stable
        ports:
        - containerPort: 3310
        resources:
          requests:
            memory: 1Gi
            cpu: 250m
          limits:
            memory: 2Gi
            cpu: 1000m
        livenessProbe:
          tcpSocket:
            port: 3310
          initialDelaySeconds: 90
          periodSeconds: 30
        readinessProbe:
          exec:
            command: ["sh", "-c", "echo 'PING' | nc -w 2 localhost 3310 | grep -q PONG"]
          initialDelaySeconds: 30
          periodSeconds: 15
        volumeMounts:
        - name: signatures
          mountPath: /var/lib/clamav
      - name: freshclam
        image: clamav/clamav:stable
        command: ["freshclam", "--daemon", "--checks=4"]   # checks/day = every 6h
        volumeMounts:
        - name: signatures
          mountPath: /var/lib/clamav
      volumes:
      - name: signatures
        persistentVolumeClaim:
          claimName: clamav-signatures
---
apiVersion: v1
kind: Service
metadata:
  name: clamav
spec:
  type: ClusterIP
  selector:
    app: clamav
  ports:
  - port: 3310
    targetPort: 3310
```

The PVC carries the signature DB so a `clamd` restart does not re-download 250 MB of signatures. The two replicas share the PVC (ReadWriteMany) — `clamd` only reads from it; `freshclam` is the single writer.

### Rejected alternatives

| Alternative | Reason rejected |
|---|---|
| **A — Per-service-pod sidecar container** (`clamd` next to every farm-service pod) | Multiplies the ~600 MB resident signature-DB memory by every pod replica. Farm-service in prod runs ~6 replicas, admin-api ~3, gateway-api ~4 — that's 13 sidecars × ~1 GB = ~13 GB of RAM dedicated to ClamAV alone. The shared model uses ~3 GB total (2 replicas × 1.5 GB). Same `freshclam` redundancy: 13 cron jobs vs 1, 13× the egress bandwidth on signature updates. Sidecar wins ONLY on per-call latency (no network hop) and the latency win is <10 ms vs the 1–5 s scan time — irrelevant. |
| **B — On-demand AWS Lambda / GuardDuty integration** | Cold-start adds 200–800 ms per scan; the steady upload volume means we'd pay the premium continuously. GuardDuty also charges per object scanned (~$0.50 per GB at 2026 prices) which beats sidecar RAM cost only if upload volume drops below ~50 GB/month — our actual volume is 5–20× higher. Lambda also requires VPC peering or NAT for reach-back into the cluster's MinIO, adding a second failure mode. |
| **C — Single-replica ClamAV (no HA)** | Loses the "deploy resilience" constraint. Upload pipeline goes down for the duration of a node drain or an OOM-kill. Phase V4's fail-closed posture would correctly return 503 — but we'd take the 503 daily under steady-state, not just under failure. 2 replicas costs +1.5 GB and removes the single point of failure. |
| **D — DaemonSet (one ClamAV per node)** | Halfway between sidecar and shared. Wastes resources on nodes that don't host upload-handling pods (analytics nodes, edge-collector nodes). Also fails if a node loses its ClamAV — pods on that node still try to upload but their local sidecar is gone. The shared Service abstracts node placement; clients don't care. |
| **E — File-system-only `clamscan` CLI invoked per upload** (no daemon) | `clamscan` re-loads the entire signature DB on every invocation (~300 ms for the load alone). At our upload rate that's measurable load. The whole point of `clamd` is to keep the DB warm. |

---

## Consequences

**Positive:**

- **Resource efficiency**: ~3 GB total RAM for the cluster's malware-scanning capacity vs ~13 GB if every upload-handling pod ran a sidecar. The savings compound as the platform grows; new services that gain upload paths don't add RAM cost — they just consume the shared Service.
- **Single signature pipeline**: one `freshclam` cron, one source of truth for "is the DB current". The Phase V6 alert rule queries one Deployment; per-pod sidecars would have made staleness a per-pod question with N alert paths.
- **Clean fail-closed dependency**: the upload controller's `clamavClient.isHealthy()` preflight (Phase V4) probes one named endpoint. With sidecars, "is ClamAV healthy" is a per-pod question with no global answer — fail-closed becomes "is MY sidecar healthy" which is wrong (an upload to pod A should still fail closed even if pod A's sidecar is fine but the cluster's ClamAV is unreachable).
- **Reusable across services**: admin-api uploads, future imaginary doc-management uploads, dashboard logo uploads all go through the same scan path without per-service infrastructure work.

**Negative:**

- **Network hop per scan**: each scan adds one cluster-internal round trip (~1 ms vs the 1–5 s scan time — negligible relative impact, but real). Sidecars would have been Unix-socket local.
- **Single point of failure if BOTH replicas fail**: 2-replica HA covers the 99.9% case; a regional networking event that takes both pods down also takes the whole cluster down, so the failure mode aligns with the cluster's blast radius rather than amplifying it.
- **PVC ReadWriteMany requirement**: the chosen shared-signatures pattern needs a CSI driver that supports RWX (NFS, CephFS, EFS, Azure Files). AWS EBS-backed clusters need EFS or a sibling. Cluster operators get one explicit dependency to provision, documented in the Phase V2 runbook.
- **`freshclam --daemon` runs in the same Pod as `clamd`**: a corrupt signature update can crash both containers in the Pod. Mitigation: `freshclam` writes to a temp dir + atomic-rename, and `clamd` reloads on SIGUSR2. The Pod's livenessProbe restarts on `clamd` crash; readinessProbe pulls the Pod from the Service until `clamd` is back. With 2 replicas, the rolling crash-recovery does not impact availability.

**Neutral / future-pivot:**

- If upload volume ever drops by an order of magnitude AND signature-DB freshness becomes Lambda-cheap, alternative B becomes economically defensible. The shared Deployment can be retired by repointing `ClamAVClientService` at a Lambda invoke URL — the rest of the pipeline (events + worker + quarantine) stays unchanged.
- If we ever need per-tenant scan isolation (a regulator-driven request — "tenant X's uploads must not share scan capacity with tenant Y"), the topology can grow to one Deployment per tenant. Today no such requirement exists; documenting the hook so the future request doesn't catch us flat-footed.

---

## Implementation hooks

Phase V2 (PR-21) wires:

- `infrastructure/kubernetes/base/clamav.yaml` — Deployment + Service + PVC matching the shape above.
- `infrastructure/kubernetes/base/clamav-freshclam-job.yaml` — CronJob that triggers a SIGUSR2 reload on the Deployment after the daemon `freshclam` writes new signatures (defence-in-depth: the daemon already reloads on update, but a 6-hourly explicit reload covers daemon-side fail-modes).
- `docker-compose.dev.yml` — `clamav` service for local dev.
- `docker-compose.infra.yml` — same, for the standalone-infra dev mode.
- `infrastructure/monitoring/prometheus/clamav-rules.yaml` — alerts: `ClamAVSignatureStale` (age > 24h), `ClamAVDown` (no healthy replicas), `ClamAVScanLatencyHigh` (p99 > 5s).

Phase V3 (PR-22) wires:

- `libs/storage/src/clamav-client.service.ts` — wraps `clamscan` Node client; reads `CLAMAV_HOST` (defaults to `clamav`) + `CLAMAV_PORT` (defaults to `3310`) from env so dev compose and prod cluster share the same code path with different DNS resolution.
- `libs/storage/src/workers/virus-scan.worker.ts` — outbox consumer for `StorageObjectUploadedEvent`.
- `libs/event-contracts/src/storage-events.ts` — extends with `StorageObjectUploadedEvent` + `FileInfectedEvent` + `FileScannedCleanEvent`.

Phase V4 (PR-23) wires:

- `libs/storage/src/file-upload-security.service.ts` — preflight `clamavClient.isHealthy()` check; if false, `ServiceUnavailableException` 503.
- `apps/farm-service/src/health/indicators/clamav.health.ts` — Terminus health indicator surfacing scan engine state on `/health/ready`.

Phase V5 / V6 are infrastructure for notification / blocklist / signature freshness alerts; they reference this ADR's named Service for their probes.

---

## Notes captured during V1 investigation (not in scope but worth surfacing)

The following were noticed during this ADR's preparation and belong in `docs/reviews/2026-04-25-implementation-notes/observations.md` for tracking:

- **Existing storage code already has an `isHealthy()` shaped seam**: `FileUploadSecurityService.preflight()` runs synchronously before `uploadFile`. Inserting a `clamavClient.isHealthy()` call before the size/mime gates is one line — no architectural rewiring needed for Phase V4.
- **The PVC ReadWriteMany requirement is environment-specific**: the canonical EBS-backed cluster needs an EFS sidecar provisioner. The Phase V2 runbook MUST document this; a deploy attempt without RWX will fail with `MountVolume.SetUp failed: only one Pod can mount a ReadWriteOnce PVC` and the operator will not have a clear next step.
- **`clamav/clamav:stable` image is ~600 MB**: image-pull caching needs to be considered for cluster startup time. The Phase V2 runbook MUST mention `imagePullPolicy: IfNotPresent` and a pre-pull DaemonSet for the cold-start case.

---

## Status discipline

This ADR is **Accepted** at the topology-decision level — Phase V1 ships ONLY the documentation. The "Accepted-and-Realised" promotion happens after Phase V2 lands the actual K8s manifest and Phase V3 lands the client + worker; until then the decision is binding for any code that REFERENCES it but no infrastructure is yet on the cluster. PR-21 (V2) closes this gap.
