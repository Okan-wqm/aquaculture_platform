# Enterprise-Scale Security Uplift Roadmap

**Date:** 2026-04-12  
**Author:** Codex review synthesis  
**Companion Review:** `docs/security/2026-04-12-hardening-gap-report.md`  
**Quality Bar:** Root-cause architectural solutions only. No symptom patches. No environment-specific shortcuts promoted to platform standard.

---

## Purpose

This document defines how the platform should move from its current mixed security posture to a security model that is credible for enterprise-scale operation.

The goal is **not** "add more controls."  
The goal is to establish a platform where the trust model is:

- explicit
- least-privilege
- fail-closed
- automatically rotated
- continuously verified
- evidenced by deployment artifacts and runtime controls, not comments

---

## What "Enterprise-Scale" Means Here

For this platform, enterprise-scale security means all of the following are true at the same time:

1. A compromised service cannot mint user tokens, impersonate another service, or read arbitrary tenant data.
2. A leaked deployment secret does not create platform-wide blast radius.
3. Every machine identity, token-signing key, broker credential, and database credential has an owner, a lifecycle, and a rotation path.
4. Production trust is established by workload identity and policy, not by convention or shared secrets.
5. Security controls are enforced in:
   code, deployment manifests, cluster policy, and CI/CD
6. Auditability is strong enough to answer:
   who did what, from where, against which tenant, through which trusted path
7. Security posture can be proven by evidence:
   manifests, policies, runtime configuration, validation tests, and audit artifacts

If any of those remain manual, optional, or environment-dependent, the platform is not yet operating at enterprise-grade security.

---

## Current Position

Based on the companion gap report, the platform is best described as:

- architecturally serious
- locally stronger than a typical startup stack
- operationally inconsistent across code, Docker production, Helm/Kubernetes, and development paths

The most important current weaknesses are:

1. JWT trust model drift between code and deployment artifacts
2. NATS authorization design stronger than checked deployment wiring
3. One-way TLS on NATS instead of mutual service identity
4. Mixed secrets posture across `.env`, Compose, Helm, and Terraform
5. Incomplete convergence on per-service isolation as the only valid production mode

That means the correct next step is not random hardening work.  
The correct next step is **trust-model consolidation**.

---

## Target Security Model

### 1. Identity and Token Trust

The platform target state should be:

- `auth-service` is the sole issuer of user-facing JWTs
- access tokens are signed with asymmetric keys only
- all consumers verify via public-key distribution or JWKS
- refresh tokens are separate from access tokens in both storage and verification path
- machine-to-machine trust does not depend on user JWTs

This means:

- `JWT_SECRET` must not remain the platform-wide verification mechanism in production
- the RS256 migration must be completed end-to-end
- public-key distribution must be explicit in deployment models
- issuer, audience, token type, key ID, and revocation semantics must be mandatory everywhere

### 2. Service-to-Service Trust

The platform target state should be:

- every workload has a machine identity
- service-to-service requests are authenticated by workload identity
- internal transport is mutually authenticated
- broker connections and internal APIs use per-workload credentials or certificates
- shared internal secrets are reduced to the smallest possible set

This means production should move to one of these two accepted patterns:

1. `SPIFFE/SPIRE` or service-mesh-backed workload identity with mTLS
2. platform-managed internal PKI with per-service client certificates and strict server-side verification

For this repo, either can work. What does **not** qualify is:

- one-way TLS plus shared credentials
- HMAC-only identity for the full platform
- per-service ACL comments without verified credential injection

### 3. Secrets and Key Management

The platform target state should be:

- production secrets sourced from a managed secret system
- no manually curated long-lived secrets embedded in Compose or hand-maintained cluster state
- signing keys, DB credentials, broker credentials, Redis credentials, and SMTP credentials all have rotation policies
- secret distribution is environment-specific but policy-consistent

Accepted production patterns:

- AWS Secrets Manager + External Secrets Operator
- Vault + External Secrets or Vault Agent
- cloud KMS-backed key storage for JWT signing keys

Not acceptable as platform standard:

- `.env` as production secret source
- undocumented file-mounted secrets
- no rotation owner

### 4. Data-Plane Isolation

The platform target state should be:

- per-service DB roles in production only
- no shared application DB role in production paths
- tenant isolation enforced at multiple layers:
  schema routing, repository boundaries, write-path invariants, and read-path verification
- privileged cross-schema reads explicitly scoped, logged, and minimized

For the current architecture, that means:

- schema ownership remains valid
- shared fallback role remains development-only
- every production deployment artifact must reflect the per-service role model

### 5. Messaging Isolation

The platform target state should be:

- NATS authorization model and deployment wiring are identical
- each service has a distinct broker identity
- subject permissions are deny-by-default
- broker auth is paired with mTLS or equivalent workload identity
- queue and event subjects are partitioned to minimize blast radius

At enterprise scale, "the config file supports ACLs" is not enough.  
The runtime artifact must prove the exact credentials and policies in use.

### 6. Runtime and Cluster Controls

The platform target state should be:

- default-deny network policy in Kubernetes
- ingress-only gateway exposure
- backend services unreachable from public paths except through explicit ingress/API gateways
- signed images, pinned dependencies, and admission policy for production deploys
- break-glass access separated and audited

### 7. Audit and Assurance

The platform target state should be:

- security-relevant actions emit durable audit records
- audit streams are tamper-evident or backed by immutable retention
- runtime configuration can be checked against expected control state
- there is a recurring verification program, not one-time hardening

---

## Strategic Direction

The fastest credible route to enterprise-scale security is not "replace everything with a service mesh tomorrow."  
The realistic path is:

1. eliminate trust-model contradictions
2. remove shared-secret blast radius
3. make production security artifacts authoritative
4. add continuous proof

That leads to five workstreams.

---

## Workstream 1 — Complete the Identity Architecture

**Priority:** P0  
**Why first:** Every other control depends on a stable trust model.

### Objective

Move the platform to one production-valid JWT architecture, with no HS256-era ambiguity in consumers or deployment artifacts.

### Required Outcomes

1. Production token issuance uses asymmetric signing only.
2. Production consumers verify via public key or JWKS only.
3. `JWT_SECRET` is not the production verification contract for user access tokens.
4. Access, refresh, machine, and challenge tokens have separate verification semantics.
5. Deployment artifacts clearly express key distribution and rotation.

### Changes

- standardize on RS256 or stronger asymmetric signing for all user access tokens
- introduce explicit JWKS or public-key distribution as platform standard
- remove legacy HS256 verification paths from active production guards
- add `kid` support and signing-key rollover
- define a production key rotation runbook with dual-publish / dual-verify window
- separate machine credentials from user JWT credentials

### Acceptance Criteria

- no production guard or middleware path accepts HS256 for user access tokens
- deployment manifests show how consumers receive verification material
- auth-service supports key rollover without global outage
- revocation, token type enforcement, issuer, and audience checks are mandatory everywhere

### Evidence

- code review of every verify path
- deployment manifest review
- key rotation rehearsal in staging
- token misuse test matrix:
  wrong `aud`, wrong `iss`, wrong `type`, expired key, rotated key, revoked token

---

## Workstream 2 — Replace Shared Internal Trust with Workload Identity

**Priority:** P1  
**Why here:** Shared internal secrets create platform-wide blast radius, but the immediate P0 work is to remove JWT and deployment-contract drift using primitives the repo already has.

### Objective

Move inter-service trust from "knows the secret" to "is the workload."

### Required Outcomes

1. Service-to-service transport is mutually authenticated.
2. Internal APIs trust workload identity, not just network location.
3. Broker access is bound to workload identity and least-privilege policy.

### Recommended Target

Near-term repo-aligned target:

- cert-manager or internal PKI issuing per-service client certs
- strict server-side client cert verification
- broker and internal API auth bound to client cert identity

Long-term optional target for the Kubernetes platform:

- `SPIFFE/SPIRE` or service mesh with workload certificates and mTLS

### Changes

- enable mTLS for NATS and internal service communication
- stop treating one-way TLS as sufficient production posture
- replace broad internal HMAC trust as the long-term identity layer
- define service identity policy:
  service name, namespace, environment, and allowed call graph

### Acceptance Criteria

- compromised app container without valid workload identity cannot connect to broker or peer services
- NATS requires authenticated clients with least-privilege identity
- internal requests are rejected if client identity is unknown or mismatched

### Evidence

- broker config with enforced client auth
- service-to-service mTLS policy
- negative tests:
  wrong cert, expired cert, unknown identity, cross-service identity reuse

---

## Workstream 3 — Standardize Secrets, PKI, and Rotation

**Priority:** P0  
**Why third:** Enterprise posture fails if rotation is manual and ownership is unclear.

### Objective

Make all production secrets and certificates managed, rotated, and auditable.

### Required Outcomes

1. Managed secret store is the production source of truth.
2. JWT signing keys have lifecycle ownership and rotation.
3. DB, Redis, NATS, and SMTP credentials have documented rotation paths.
4. Internal certificates have issuance and renewal automation.

### Changes

- adopt one production secret authority:
  AWS Secrets Manager is the most aligned with checked Terraform/Helm assets
- use External Secrets Operator as cluster delivery mechanism
- store JWT private keys in managed secret or KMS-backed signing service
- define cert issuance for internal transport:
  cert-manager + internal CA or Vault PKI
- eliminate undocumented manual secret injection paths in production

### Acceptance Criteria

- every production secret class has:
  owner, source of truth, rotation frequency, revocation path, and delivery path
- no production deployment depends on untracked `.env` material
- internal cert renewal is automatic or operator-managed with alerting

### Evidence

- secret inventory
- rotation runbooks
- Terraform / Helm / ExternalSecret manifests
- successful staged rotation drills

---

## Workstream 4 — Make Isolation Models Authoritative

**Priority:** P1  
**Why now:** Once trust is stabilized, blast radius must be minimized by policy.

### Objective

Converge database, broker, network, and tenancy isolation so the production path has only one valid mode.

### Required Outcomes

1. Shared DB role is not used in production.
2. NATS ACLs and deployed credentials match exactly.
3. Kubernetes network policy is default-deny and enforced.
4. tenant isolation remains defense-in-depth, not convention-only.

### Changes

- remove shared DB fallback from production deployment paths
- make per-service DB role use mandatory in production checks
- align broker credentials and ACL subjects with deployment manifests
- require production overlays to pass isolation conformance checks
- add guardrails preventing deployment of weak dev defaults into prod

### Acceptance Criteria

- production manifests cannot deploy with shared app DB user
- production manifests cannot deploy NATS without auth and mTLS
- environment drift between Compose prod, Helm, and code contracts is tracked as a release blocker

### Evidence

- release gating checks
- manifest conformance tests
- drift report generated in CI

---

## Workstream 5 — Add Continuous Assurance and Supply-Chain Controls

**Priority:** P1  
**Why here:** Enterprise scale is sustained by proof, not one-time projects.

### Objective

Turn security from a migration effort into a governed operating model.

### Required Outcomes

1. Build pipeline proves what is shipped.
2. Cluster admission and runtime policy constrain what can run.
3. Security controls are regularly re-verified.

### Changes

- SBOM generation for backend, frontend, and edge artifacts
- image signing and verification at admission
- IaC scanning for Terraform, Helm, Kubernetes manifests
- dependency and container vulnerability gates
- policy-as-code for production invariants:
  no wildcard ingress, no missing network policy, no shared DB user, no weak broker config
- periodic control verification audits:
  JWT path audit, NATS auth audit, tenant isolation audit, edge credential audit

### Acceptance Criteria

- a release can be blocked automatically for security invariant violations
- production images are signed and admitted by policy
- recurring security verification artifacts are produced and retained

### Evidence

- CI reports
- admission policy manifests
- signed image attestations
- scheduled audit outputs in `docs/security` or equivalent evidence store

---

## Platform-Specific Enterprise Priorities

The platform is not a generic CRUD SaaS. It has:

- multi-tenant backend services
- mobile/PWA surfaces
- NATS-based internal messaging
- industrial/edge integration
- Rust gateway / device paths

That means enterprise security should prioritize these platform-specific risks.

### A. Edge and Industrial Trust Boundary

This platform has a higher-than-normal operational risk because edge and industrial connectivity exists alongside SaaS workloads.

Enterprise target:

- edge devices must have distinct device identity
- OTA/update paths must be signed and verified
- broker access for edge paths must be segregated from core service trust
- edge compromise must not allow lateral movement into core tenant APIs

This should be treated as a dedicated security domain, not just another backend service.

### B. Tenant Boundary Assurance

Because the platform is multi-tenant, enterprise credibility requires recurring proof that:

- tenant context cannot be injected across request, queue, read model, export, or batch job boundaries
- admin cross-tenant functions are explicit, rare, and audited

### C. Mobile and Offline Security

For AquaMobil and offline-capable paths, enterprise target should include:

- token lifecycle discipline
- secure offline storage for sensitive cached state
- replay-safe sync semantics
- auditable handling of revoked sessions and stale credentials

---

## Sequencing

### Phase 1 — Trust Model Consolidation

Duration target: `2-4 weeks`

- complete JWT architecture decision
- remove active HS256-era production ambiguity
- define public-key/JWKS distribution standard
- choose workload identity approach for production target

**Exit condition:** one documented and enforceable production trust model

### Phase 2 — Production Identity and Secret Rollout

Duration target: `3-6 weeks`

- move production secret authority to managed store
- deploy key and credential distribution through standard mechanism
- introduce rotation ownership and staged drills
- enable mTLS or equivalent workload identity on internal transport

**Exit condition:** production secrets and internal trust are managed, not manual

### Phase 3 — Isolation Convergence

Duration target: `2-4 weeks`

- per-service DB role enforcement
- broker ACL rollout verification
- network policy enforcement
- release gating for drift

**Exit condition:** production path has one valid isolation model

### Phase 4 — Assurance and Governance

Duration target: `ongoing`

- supply-chain controls
- scheduled control verification
- immutable audit evidence
- executive reporting / control health dashboard

**Exit condition:** security becomes operational discipline rather than project work

---

## Non-Negotiable Production Standards

These should become release-blocking standards.

1. No production deployment may rely on shared JWT verification secrets for user access tokens.
2. No production broker deployment may run without authentication and mutually authenticated transport.
3. No production service may run with shared DB application credentials.
4. No production secret may exist without:
   owner, source, rotation policy, and delivery path
5. No production backend may be reachable except through explicit ingress/gateway policy.
6. No security-sensitive control may exist only in comments or helper docs; it must appear in deployment artifacts and verification tests.

---

## Recommended Operating Model

To keep the uplift durable, assign ownership by control family rather than by random ticket flow.

### Identity Owner

Owns:

- JWT architecture
- signing key lifecycle
- auth-service issuance model
- consumer verification contract

### Platform Security / Infra Owner

Owns:

- workload identity
- mTLS
- broker auth
- secret delivery
- network policy
- admission controls

### Data Platform Owner

Owns:

- DB role isolation
- migration safety
- tenant isolation verification
- privileged cross-schema access controls

### Service Owners

Own:

- correct integration with platform trust model
- no bypass paths
- audit coverage on privileged actions

This separation matters because enterprise security fails when everyone assumes "infra" or "auth" owns everything.

---

## How Success Should Be Measured

Success is not "we added mTLS" or "we use Secrets Manager."  
Success is when the following statements become provably true:

- a compromised service cannot mint user tokens
- a leaked service credential cannot access unrelated broker subjects
- a shared fallback DB user cannot accidentally reach production
- a rotated signing key does not require emergency coordination across all services
- a revoked token, expired cert, wrong workload identity, or mis-scoped tenant request fails closed

If those properties are true and routinely tested, the platform is operating much closer to enterprise scale.

---

## Final Recommendation

The platform should **not** pursue broad security work as independent fixes.  
It should adopt a single transformation objective:

**Make production trust explicit, asymmetric, identity-bound, rotated, and provable.**

That means the first enterprise-security milestone is not "more controls."  
It is this:

- one JWT model
- one machine identity model
- one secrets source of truth
- one production isolation model
- one recurring verification program

Everything else should follow from that.
