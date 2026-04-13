# Enterprise Security Execution Plan — P0 / P1

**Date:** 2026-04-12  
**Companion Strategy:** `docs/security/2026-04-12-enterprise-security-uplift-roadmap.md`  
**Companion Review:** `docs/security/2026-04-12-hardening-gap-report.md`  
**Execution Rule:** Start with controls already present in the repo but inconsistently wired. Do not introduce a new trust layer before the current one is coherent.

---

## Why This Plan Is Different

This plan is intentionally narrower than the roadmap.

The roadmap defines the enterprise target state.  
This document defines the **real execution order** that fits the current codebase.

The repo already contains useful security building blocks:

- RS256 issuer / verifier code paths
- JWKS endpoint support
- HMAC-based service identity guard
- NATS TLS and auth client knobs
- per-service DB roles
- External Secrets / AWS Secrets Manager patterns
- Kubernetes network policy and Pod Security standards
- optional cosign image signing hooks
- gateway-level OPA substrate

The immediate problem is not lack of ideas.  
The immediate problem is **incomplete convergence**.

So P0 focuses on making the existing trust model coherent.  
P1 extends that coherent base toward enterprise-grade workload identity and enforcement.

---

## Current Foundations To Reuse

### Identity Foundations Already Present

- RS256 issuer support in `auth-service`
- RS256 verifier support in shared JWT utilities
- JWKS endpoint in auth-service
- JWKS fetch/cache service in shared code

### Internal Trust Foundations Already Present

- `ServiceIdentityGuard` on multiple backend services
- gateway header signing via `generateServiceIdentityHeaders(...)`
- NATS TLS CA and optional client certificate support in event-bus code

### Platform Foundations Already Present

- External Secrets template for Helm
- AWS Secrets Manager patterns in Terraform
- per-service DB roles in init scripts and production compose
- Kubernetes `NetworkPolicy`, `ServiceAccount`, restricted Pod Security labels
- optional cosign hooks for image signing

These are enough to execute a serious P0 without inventing a new platform.

---

## P0 — Converge The Existing Production Trust Model

**Goal:** remove contradictions between code, manifests, and intended production controls

### Package P0-1 — JWT Contract Convergence

**Objective:** make one production-valid JWT model real across code and deployment.

### Changes

- remove active HS256 verification from production user-token paths
- make `JWT_PRIVATE_KEY` or `JWT_PRIVATE_KEY_PATH` the auth-service production signing contract
- make `JWT_PUBLIC_KEY` or `JWT_PUBLIC_KEY_PATH` the consumer production verification contract
- stop using `JWT_SECRET` as the production verification contract for user access tokens
- standardize `kid`, `issuer`, `audience`, `type`, and revocation enforcement
- keep JWKS endpoint enabled as supported distribution path

### Repo Assets To Reuse

- `apps/auth-service/src/app.module.ts`
- `apps/auth-service/src/modules/authentication/jwks.controller.ts`
- `apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts`
- `libs/backend-common/src/auth/jwt-verification.utils.ts`
- `apps/gateway-api/src/middleware/jwt.middleware.ts`

### Deliverables

1. Code path audit of every JWT verify call
2. Updated production env contract for auth-service and consumers
3. Updated Compose / Helm manifests reflecting the asymmetric model
4. Rotation note for `current` and `previous` key pair support

### Acceptance Criteria

- no production JWT verify path for user access tokens accepts HS256
- auth-service signs with asymmetric key material only
- consumers verify with public key material only
- production manifests show explicit signing and verification inputs

### Package P0-2 — Deployment Contract Convergence

**Objective:** make root production compose, infrastructure compose copy, Helm, and Kubernetes tell the same security story.

### Changes

- align root `docker-compose.prod.yml` with the RS256 and broker auth model
- align `infrastructure/docker/docker-compose.prod.yml` with the canonical root file
- align Helm secret schema with the actual JWT and broker contract
- define which deployment path is authoritative for production:
  root compose or Helm/Kubernetes
- mark any non-authoritative production artifact as legacy or documentation-only

### Repo Assets To Reuse

- `docker-compose.prod.yml`
- `infrastructure/docker/docker-compose.prod.yml`
- `infrastructure/helm/aquaculture/templates/secrets.yaml`
- `infrastructure/helm/aquaculture/templates/_helpers.tpl`

### Acceptance Criteria

- there is no production manifest set that still assumes HS256-era JWT verification
- there is no checked production manifest that contradicts the selected production security model
- security-sensitive env names are consistent across deployment paths

### Package P0-3 — NATS Auth and TLS Convergence

**Objective:** move NATS from “good design on paper” to “real deployed least privilege.”

### Changes

- choose one broker auth model for production:
  per-service user/pass or token model
- make deployment env injection match `nats.conf`
- remove ambiguous shared fallback use in production
- enforce broker TLS with CA validation on all production clients
- standardize required NATS env contract across services

### Repo Assets To Reuse

- `infrastructure/docker/nats/nats.conf`
- `infrastructure/docker/nats/nats-tls-enabled.conf`
- `platform/libs/event-bus/src/nats/nats-event-bus.ts`
- `libs/backend-common/src/nats/nats-connection.factory.ts`
- gateway websocket NATS bridge services

### Acceptance Criteria

- every production service connects with an authenticated broker identity
- production broker clients do not use plaintext `nats://`
- deployment artifacts and `nats.conf` agree on auth inputs
- the shared fallback credential is not the de facto production mode

### Package P0-4 — Production Isolation Enforcement

**Objective:** make weak shared fallbacks impossible in production paths.

### Changes

- codify per-service DB role use as the only valid production mode
- reject shared DB user usage in production manifests
- codify production-only isolation invariants for:
  DB user, NATS auth, NATS TLS, internal network, ingress model
- add drift checks between root compose and Helm/Kubernetes

### Repo Assets To Reuse

- `infrastructure/docker/init-scripts/00-init-schemas.sh`
- `docker-compose.prod.yml`
- `infrastructure/helm/aquaculture/templates/networkpolicy.yaml`
- `infrastructure/kubernetes/base/namespace.yaml`

### Acceptance Criteria

- no production manifest uses the shared `aquaculture` app user
- no production manifest deploys broker without auth + TLS
- drift between the declared production path and checked manifests is reportable in CI

### Package P0-5 — Managed Secret Authority Convergence

**Objective:** make production secret sourcing explicit and operator-safe.

### Changes

- declare one production secret authority:
  AWS Secrets Manager is the best fit for existing repo assets
- deliver production secrets through External Secrets Operator for Kubernetes
- explicitly classify root compose production as:
  transitional, break-glass, or unsupported
- document secret ownership and rotation class for:
  JWT signing keys, DB creds, NATS creds, Redis creds, SMTP creds

### Repo Assets To Reuse

- `infrastructure/helm/aquaculture/templates/secrets.yaml`
- `infrastructure/helm/aquaculture/values-production.yaml`
- `infrastructure/kubernetes/base/secrets.yaml`
- `infrastructure/terraform/modules/rds/main.tf`
- `infrastructure/terraform/modules/elasticache/main.tf`

### Acceptance Criteria

- Kubernetes production path sources secrets from External Secrets
- secret classes and owners are documented
- production does not depend on undocumented `.env` or manual file mounts

### Package P0-6 — Security Conformance Gates

**Objective:** stop security drift from re-entering the repo.

### Changes

- add CI checks for banned production patterns:
  `JWT_SECRET` verification contract outside auth-service
  `nats://` in production manifests
  shared DB user in production manifests
  missing `NATS_TLS_CA` on `tls://` clients
- add manifest conformance checks between production artifacts
- produce a machine-readable control report per CI run

### Acceptance Criteria

- a release fails when production manifests violate the selected security contract
- security drift becomes visible before deploy, not during incident review

---

## P1 — Extend To Enterprise-Grade Internal Identity And Assurance

**Goal:** after P0 convergence, move from coherent controls to stronger, lower-blast-radius controls

### Package P1-1 — Internal PKI and Mutual Authentication

**Objective:** replace one-way transport trust and shared internal secret assumptions with mutually authenticated workloads.

### Changes

- require client certificates for NATS
- add per-service client cert issuance and renewal
- update broker config from `verify: false` to required client verification
- extend internal service trust from shared-secret HMAC toward cert-bound identity

### Repo Assets To Reuse

- `infrastructure/docker/nats/nats-tls-enabled.conf`
- `infrastructure/docker/scripts/generate-internal-certs.sh`
- `platform/libs/event-bus/src/nats/nats-event-bus.ts`
- gateway websocket bridge TLS client-cert hooks

### Acceptance Criteria

- NATS rejects clients without trusted client certs
- internal service identities are certificate-bound rather than shared-secret-only

### Package P1-2 — Dynamic Key Discovery and Rollover

**Objective:** move key rotation from static secret fan-out toward discovery-based verification.

### Changes

- wire consumers to JWKS-backed verification where appropriate
- use existing JWKS endpoint and shared JWKS client as the base
- formalize `current` / `previous` key rollover windows
- add key rollover verification tests

### Repo Assets To Reuse

- `apps/auth-service/src/modules/authentication/jwks.controller.ts`
- `libs/backend-common/src/guards/jwks.service.ts`

### Acceptance Criteria

- signing key rotation no longer requires synchronous manual redeploy of every consumer
- verification supports overlap window for current and previous key

### Package P1-3 — Signed Images and Admission Enforcement

**Objective:** make signed artifacts and cluster enforcement part of the release path.

### Changes

- enable cosign signing for all production images, not only optional or edge-only paths
- add admission policy for signature verification
- fail deploys for unsigned or untrusted images

### Repo Assets To Reuse

- `.github/actions/docker-build-push/action.yml`
- `.github/workflows/edge-agent-release.yml`
- Kubernetes restricted pod security baseline already present

### Acceptance Criteria

- all production images are signed
- cluster admission rejects unsigned images

### Package P1-4 — Workload Identity For Cloud Secret Access

**Objective:** stop long-lived cloud credential distribution and bind secret access to workload identity.

### Changes

- use Kubernetes service accounts plus cloud workload identity for secret retrieval
- on EKS, use IRSA-style service-account-to-IAM mapping
- scope secret access by workload role

### Repo Assets To Reuse

- `infrastructure/terraform/modules/eks/main.tf`
- `infrastructure/helm/aquaculture/templates/serviceaccount.yaml`
- External Secrets / ClusterSecretStore path already modeled

### Acceptance Criteria

- workloads retrieve only the secrets they are entitled to
- no shared cloud secret reader identity spans the whole platform

### Package P1-5 — Edge and Device Trust Boundary

**Objective:** separate industrial/edge identity from core SaaS service identity.

### Changes

- define a dedicated device identity model for edge and industrial adapters
- separate edge broker/API trust from core service trust
- require signed update / release provenance for edge artifacts
- prevent edge compromise from inheriting core service credentials

### Repo Assets To Reuse

- `sens-api-gateway/`
- `.github/workflows/edge-agent-release.yml`
- sensor-service industrial protocol and certificate-bearing entities

### Acceptance Criteria

- edge device trust is not implemented as a weak variant of backend service trust
- edge artifact provenance is verifiable

### Package P1-6 — Runtime Security Assurance

**Objective:** turn the security model into continuously verifiable evidence.

### Changes

- recurring conformance audits for JWT, broker auth, DB role isolation, and tenant boundaries
- runtime config evidence collection
- audit integrity improvements for security-critical flows
- policy-as-code expansion using the existing gateway OPA substrate and cluster controls

### Repo Assets To Reuse

- `apps/gateway-api/src/opa/`
- `infrastructure/helm/aquaculture/templates/networkpolicy.yaml`
- existing audit infrastructure in `libs/backend-common/src/audit/`

### Acceptance Criteria

- control evidence is generated on a schedule
- security posture is measurable, not inferred

---

## Package Dependencies

### Hard Dependencies

1. `P0-1 JWT Contract Convergence` before `P1-2 Dynamic Key Discovery and Rollover`
2. `P0-2 Deployment Contract Convergence` before all later production enforcement work
3. `P0-3 NATS Auth and TLS Convergence` before `P1-1 Internal PKI and Mutual Authentication`
4. `P0-5 Managed Secret Authority Convergence` before `P1-4 Workload Identity For Cloud Secret Access`
5. `P0-6 Security Conformance Gates` should start during P0 and remain active afterward

### Sequencing Rule

Do not start:

- SPIFFE/SPIRE
- full internal PKI
- cluster signature admission

until the current deployment contracts and secret contracts stop contradicting the codebase.

---

## Exit Criteria By Phase

### P0 Complete When

- production JWT model is singular and asymmetric
- production manifests no longer contradict the code
- NATS auth and TLS inputs are coherent and real
- production secrets have one declared authority
- CI blocks reintroduction of weak production patterns

### P1 Complete When

- internal broker and service transport are mutually authenticated
- key discovery and rollover are routine
- image provenance is enforced
- workload identity governs secret access
- edge trust boundary is explicitly separated
- runtime evidence proves control health

---

## Final Rule

The first enterprise milestone is not "deploy a mesh."  
The first enterprise milestone is:

- one JWT contract
- one broker auth contract
- one production secret authority
- one production isolation model
- one conformance gate set

If those are not stable, later enterprise controls will sit on a weak foundation.
