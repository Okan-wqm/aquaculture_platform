# Infrastructure Review Report

**Date:** 2026-04-10  
**Reviewer:** infra-expert  
**Scope:** `infra/**`, `.github/actions/**`, production compose files, deployment workflows, and adjacent runtime infrastructure  
**Decision:** **BLOCK**

## Summary

| Severity | Count |
|---|---:|
| CRITICAL | 2 |
| HIGH | 2 |
| MEDIUM | 1 |

## Findings

### CRITICAL-001 - Production PostgreSQL still uses the shared superuser in the droplet deployment

The active droplet path still wires every backend service to `${POSTGRES_USER:-aquaculture}` in `docker-compose.droplet.yml` instead of the per-service roles created by the init script. The init script already creates `auth_service`, `farm_service`, `sensor_service`, `billing_service`, `hr_service`, `alert_service`, `admin_service`, `gateway_service`, `notification_service`, `hydroponics_service`, and `messaging_service`, but production services never consume those credentials.

Evidence:
- `infrastructure/scripts/setup-droplet.sh:114-115` deploys `docker-compose.droplet.yml`
- `docker-compose.droplet.yml:297, 402, 453, 501, 562, 612, 655, 698, 741, 784, 832, 870, 913`
- `infrastructure/docker/init-scripts/00-init-schemas.sh:170-215`

Impact:
- Any compromised backend container gets superuser-equivalent access across schemas.
- The schema isolation the init script tries to establish is effectively bypassed in production.

Remediation:
- Switch every backend service in the droplet compose to its own service role and password.
- Remove the shared application user from the production path, not just from the init script comments.

Cross-domain dependencies:
- `data-expert`
- `security-reviewer`

### CRITICAL-002 - NATS still uses one shared broker identity for all services

The production NATS config exposes a single `authorization` block with one `user` / `password` pair, and the droplet compose shares that same broker identity across every backend service via the `x-nats-env` anchor. That means the broker cannot distinguish service identity or enforce per-service publish/subscribe boundaries.

Evidence:
- `docker-compose.droplet.yml:30-35`
- `docker-compose.droplet.yml:200-208`
- `infrastructure/docker/nats/nats.conf:41-45`

Impact:
- One compromised service can impersonate the rest on the broker.
- Subject-level authorization and tenant/service isolation are not enforceable with the current model.

Remediation:
- Move to per-service NATS accounts or per-service users with explicit subject ACLs.
- Keep the shared CA, but stop sharing the same broker credential across all services.

Cross-domain dependencies:
- `security-reviewer`
- `messaging-expert`
- all NATS-consuming backend services

### HIGH-001 - Production deploys are still mutable because they consume `:latest` images

Both production compose files deploy from mutable `:latest` tags, while the build workflow already publishes immutable `:${{ env.TAG }}` refs alongside `latest`. The deploy scripts then pull `latest`, so the running environment is not tied to the image revision that was built and tested.

Evidence:
- `scripts/deploy-do.sh:37-43`
- `infrastructure/scripts/setup-droplet.sh:114-115`
- `docker-compose.prod.yml:114, 155, 181, 207, 232, 257, 282, 310, 343, 375, 406, 418, 425, 432, 439, 446, 453, 460`
- `docker-compose.droplet.yml:283, 389, 440, 488, 548, 599, 642, 685, 728, 771, 819, 856, 901, 965, 980, 996, 1012, 1028, 1044, 1060, 1076, 1092`
- `.github/workflows/deploy-digitalocean.yml:626-627, 692-693`

Impact:
- Rollouts are not reproducible.
- Rollback is ambiguous because `latest` can move under the same compose file without any repo change.

Remediation:
- Deploy by immutable tag or digest, not by `latest`.
- Keep `latest` only as a convenience alias if needed, but do not use it as the production deployment target.

Cross-domain dependencies:
- `security-reviewer`
- `test-runner`
- all service owners that consume release images

### HIGH-002 - Image vulnerability scanning only covers `gateway-api`

The Trivy image scan job pulls and scans only `gateway-api:latest`, even though the deploy workflow builds and pushes a full backend/frontend image set. Every other pushed image can reach production without an image-level HIGH/CRITICAL scan gate.

Evidence:
- `.github/workflows/security-trivy.yml:60-75`
- `.github/workflows/deploy-digitalocean.yml:618-693`

Impact:
- Vulnerable images can ship without ever being scanned as images.
- The weekly scan does not cover the actual release surface.

Remediation:
- Scan every built/pushed release image before deploy, not one representative image.
- Fail the pipeline on HIGH/CRITICAL findings for each image that is actually shipped.

Cross-domain dependencies:
- `security-reviewer`
- all release-image owners

### MEDIUM-001 - CI and deploy workflows still use `npm install` instead of `npm ci`

Multiple workflow jobs still resolve dependencies with `npm install`, which can rewrite or drift from the lockfile and makes CI behavior less deterministic than the Docker build path. The deploy workflow does this on the release-critical path as well.

Evidence:
- `.github/workflows/ci-full.yml:60-61, 111-112`
- `.github/workflows/deploy-digitalocean.yml:288-289, 433-434`

Impact:
- Build/test behavior can diverge between CI and the production Docker build.
- Lockfile drift becomes a hidden source of flaky or non-reproducible deploys.

Remediation:
- Standardize these jobs on `npm ci`.
- If a helper action is used later, make the install command explicit and deterministic there too.

Cross-domain dependencies:
- `test-runner`

## Notes

- Static review only; I did not run tests or mutate runtime files.
- `docker-compose.droplet.yml` is the active droplet deploy path in `infrastructure/scripts/setup-droplet.sh`, so the findings above are production-relevant, not just documentation drift.
