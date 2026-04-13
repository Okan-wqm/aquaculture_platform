# Enterprise Security Plan Validation — Codebase Reality Check

**Date:** 2026-04-12  
**Validated Documents:**

- `docs/security/2026-04-12-enterprise-security-uplift-roadmap.md`
- `docs/security/2026-04-12-enterprise-security-execution-plan.md`

**Method:** static repo validation only  
**Question Answered:** Are the written security recommendations grounded in the current codebase, partially grounded, or currently too aspirational?

---

## Overall Verdict

The strategy and execution plan are **mostly grounded in the current repo**, but only if they are interpreted correctly:

- the **roadmap** is a target-state document
- the **execution plan** is the realistic path from the current codebase

The major correction needed after validation was sequencing:

- full workload identity / mTLS should **not** be treated as immediate P0 work
- the immediate P0 work is to reconcile the trust model already present in the repo

That correction has already been applied to the roadmap and reflected in the execution plan.

### Confidence Summary

| Area | Reality Status |
|---|---|
| JWT convergence plan | Grounded |
| JWKS / key rollover direction | Grounded but not yet wired |
| External Secrets / AWS Secrets Manager direction | Grounded |
| NATS auth / TLS convergence | Grounded |
| Internal PKI / mTLS | Grounded as next-step design, not current reality |
| SPIFFE/SPIRE | Possible long-term, not current repo-native |
| Image signing | Partially grounded |
| Cluster admission for signed images | Not yet grounded in checked manifests |
| OPA / policy-as-code | Partially grounded |
| Edge/device trust separation | Grounded and should be included |

---

## What Is Clearly Grounded In The Codebase

### 1. RS256 Completion Is Realistic, Not Imaginary

This is strongly grounded because the repo already contains:

- asymmetric signing logic in `apps/auth-service/src/app.module.ts`
- asymmetric verification logic in `libs/backend-common/src/auth/jwt-verification.utils.ts`
- gateway verifier setup in `apps/gateway-api/src/app.module.ts`
- auth-service JWKS endpoint in `apps/auth-service/src/modules/authentication/jwks.controller.ts`

This means the security plan is not inventing RS256.  
It is finishing a migration that is already underway.

### 2. JWKS-Based Rotation Is Grounded, But Not Yet Activated

The repo already contains:

- a JWKS controller in auth-service
- a shared `JwksService` in backend-common
- `current` and `previous` key fields in the JWKS endpoint

Evidence base:

- `apps/auth-service/src/modules/authentication/jwks.controller.ts`
- `libs/backend-common/src/guards/jwks.service.ts`

However, the JWKS fetcher appears to be **defined but not wired into active consumer verification paths**.  
So the plan is grounded, but the feature is not yet operationally complete.

### 3. Service Identity Hardening Is Grounded

The repo already has a transitional machine-trust layer:

- `ServiceIdentityGuard`
- `generateServiceIdentityHeaders(...)`
- `verifyServiceIdentity(...)`
- multiple backend services registering the guard
- gateway signing requests to subgraphs

Evidence base:

- `libs/backend-common/src/guards/service-identity.guard.ts`
- `libs/backend-common/src/utils/service-identity.util.ts`
- `apps/gateway-api/src/app.module.ts`
- multiple backend `app.module.ts` files

This means the plan to strengthen service identity is grounded in an existing pattern.  
The plan is not introducing trust from zero; it is replacing a shared-secret variant with stronger identity.

### 4. NATS TLS/Auth Convergence Is Grounded

This is grounded because the repo already has:

- broker auth design in `infrastructure/docker/nats/nats.conf`
- TLS server config in `infrastructure/docker/nats/nats-tls-enabled.conf`
- client TLS CA handling in `libs/backend-common/src/nats/nats-connection.factory.ts`
- richer client TLS auth support in `platform/libs/event-bus/src/nats/nats-event-bus.ts`
- gateway websocket NATS bridges reading CA/cert/key

So the plan is not hypothetical.  
The real issue is rollout and standardization.

### 5. Managed Secrets Direction Is Strongly Grounded

This is one of the best-grounded parts of the plan.

The repo already has:

- External Secrets templates
- production values pointing to `aws-secrets-manager`
- Kubernetes secret schema placeholders
- Terraform Secrets Manager resources and rotation for RDS and Redis

Evidence base:

- `infrastructure/helm/aquaculture/templates/secrets.yaml`
- `infrastructure/helm/aquaculture/values-production.yaml`
- `infrastructure/kubernetes/base/secrets.yaml`
- `infrastructure/terraform/modules/rds/main.tf`
- `infrastructure/terraform/modules/elasticache/main.tf`

So the move to one production secret authority is clearly real.

### 6. Production Isolation Enforcement Is Grounded

This is grounded because the repo already has:

- per-service DB roles
- production compose using service-specific DB users
- Kubernetes network policy
- Pod Security restricted namespace labels
- per-service ServiceAccounts and restricted Role bindings

Evidence base:

- `infrastructure/docker/init-scripts/00-init-schemas.sh`
- `docker-compose.prod.yml`
- `infrastructure/helm/aquaculture/templates/networkpolicy.yaml`
- `infrastructure/kubernetes/base/namespace.yaml`
- `infrastructure/kubernetes/base/rbac.yaml`
- `infrastructure/helm/aquaculture/templates/serviceaccount.yaml`

---

## What Is Only Partially Grounded

### 1. OPA / Policy-As-Code Is Real, But Not Yet A Platform-Wide Control Plane

The repo contains a substantial OPA substrate in gateway:

- `apps/gateway-api/src/opa/opa-client.service.ts`
- `apps/gateway-api/src/opa/policy-enforcer.service.ts`
- `apps/gateway-api/src/guards/opa-policy.guard.ts`
- `apps/gateway-api/src/config/opa.config.ts`

That means policy-as-code is not a fantasy.

But the validation also shows:

- clear evidence of implementation and tests
- unclear evidence of broad active route integration from the checked search results
- no cluster admission OPA / Gatekeeper / Kyverno enforcement in checked manifests

So the correct classification is:

- **application-level OPA substrate exists**
- **platform-wide policy enforcement is partial**

### 2. Image Signing Exists, But Enforcement Is Partial

The repo has:

- optional cosign support in `.github/actions/docker-build-push/action.yml`
- explicit edge artifact signing in `.github/workflows/edge-agent-release.yml`

This is good groundwork.

But what is not evidenced:

- cosign required for all production image builds
- admission policy verifying signatures before deploy

So "signed images and admission enforcement" is a valid P1 direction, but only the signing substrate is currently present.

### 3. Workload Identity For Cloud Secret Access Is Possible, Not Yet Implemented End-to-End

The repo has:

- EKS OIDC / IRSA foundation in Terraform
- Helm service account annotation hooks
- External Secrets production direction

Evidence base:

- `infrastructure/terraform/modules/eks/main.tf`
- `infrastructure/helm/aquaculture/templates/serviceaccount.yaml`

What is not yet evidenced:

- service-specific IRSA role mappings for the platform services
- checked app-service annotations binding workloads to cloud roles

So this is realistic P1, not current reality.

### 4. Internal PKI Is Partly Grounded

The repo has:

- internal cert generation script
- NATS TLS client-cert support in event-bus and gateway bridges
- TLS server config that can be moved to client verification

But:

- the current checked NATS config still uses `verify: false`
- internal cert issuance and renewal are manual
- shared backend NATS factory only proves CA validation, not full client-cert use everywhere

So mutual-auth transport is grounded, but not yet operationally complete.

---

## What Would Be "Hayal" If Interpreted As Immediate

These are not bad ideas.  
They are simply **not immediate repo-native moves** today.

### 1. Immediate SPIFFE/SPIRE Rollout

This is possible long-term, but the checked repo currently shows:

- HMAC-based service identity
- TLS hooks
- service accounts
- no SPIFFE/SPIRE manifests, agents, or identity documents

So SPIFFE/SPIRE is valid as optional long-term architecture, not immediate implementation baseline.

### 2. Immediate Cluster Admission Verification For Signed Images

There is no checked evidence of:

- Kyverno / Gatekeeper policy for signature verification
- Sigstore policy-controller
- cosign verification admission path

So admission enforcement is not current infrastructure reality yet.

### 3. Current Tamper-Evident Audit Integrity

Audit infrastructure exists, but the repo review did not establish:

- immutable storage
- append-only guarantees at the storage layer
- tamper-evident hashing or chained integrity proofs

So "tamper-evident or immutable audit" is a valid future control, not a current supported statement.

### 4. KMS-Backed JWT Signing Service As Immediate Default

This is a valid strategic option, but the checked repo currently uses:

- env/file key loading
- JWKS publication

There is no direct checked implementation of remote signing or KMS-backed signing flow.  
So this should remain optional architecture, not execution baseline.

---

## What Was Missing And Needed To Be Explicit

### 1. Edge / Device Identity Had To Be Added

The original strategy focused mostly on backend and cluster trust.  
Given this repo includes edge and industrial protocol surfaces, a real enterprise security plan must explicitly cover:

- edge identity
- signed release provenance
- separation of edge trust from core service trust

This is now explicitly included in the execution plan as `P1-5`.

### 2. Drift Detection Had To Be Elevated

The repo’s main security problem is drift between:

- code
- root production compose
- infrastructure compose copy
- Helm / Kubernetes templates

That means security conformance checks are not optional polish.  
They are core architecture work.  
This is now explicit in `P0-6`.

### 3. Sequencing Had To Be Corrected

Before validation, the strategy could be misread as:

- "start with workload identity / mTLS immediately"

After validation, the real sequence is:

1. finish JWT and deployment contract convergence
2. finish broker auth and secret authority convergence
3. then move to mutual-auth workload identity

That is the correct order for this codebase.

---

## Final Validation Judgment

### The Roadmap

The roadmap is **valid as a target-state document** after the sequencing correction.

### The Execution Plan

The execution plan is **realistic and codebase-aligned**.

It is realistic because it starts with controls the repo already has in partial form:

- RS256
- JWKS
- HMAC service identity
- NATS TLS/auth knobs
- External Secrets
- per-service DB roles
- network policy

### The Remaining Caveat

The only way these documents become "hayal" is if they are interpreted as:

- "all of this exists already"
- or "advanced workload identity should be the first implementation step"

That is not what the documents now say.

The correct reading is:

- the target state is ambitious but defensible
- the execution path is grounded in the actual repo
- several advanced controls are deliberately P1 because they are not yet native to the checked deployment model

---

## Short Conclusion

The written plan is **not fantasy**.  
It is mostly aligned with the current codebase, with these qualifications:

- some controls already exist and need convergence
- some controls exist as substrate but are not fully wired
- some controls are valid next-stage architecture, not current implementation

That is the right shape for an enterprise-security program in this repo.
