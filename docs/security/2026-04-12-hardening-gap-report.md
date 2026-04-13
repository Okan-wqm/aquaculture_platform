# Security Hardening Gap Report — Repo Evidence

**Date:** 2026-04-12  
**Scope:** Authentication, inter-service transport, database access isolation, secrets handling, network isolation, boundary validation, audit logging  
**Method:** Static repo review only. No live cluster, no runtime shell into containers, no secret values, no external system verification.  
**Status:** Review-only

---

## Executive Summary

The previously proposed security summary is **partially valid**, but it overstates certainty and mixes three different realities:

1. **Target architecture** documented in code comments and helper libraries
2. **Checked deployment artifacts** in Docker Compose / Helm / Kubernetes / Terraform
3. **Local development defaults** that intentionally weaken some controls

The main issue is not one missing control. The main issue is **security drift** between code, deployment manifests, and platform intent.

The strongest example is JWT:

- The codebase target state is clearly **RS256 asymmetric signing with auth-service as sole issuer**
- Some shared verification utilities enforce that model
- But at least one active auth-service guard still verifies with **HS256**
- Checked production deployment artifacts still distribute `JWT_SECRET` rather than an RS256 key pair

That means the statement "`JWT RS256 asymmetric: güçlü`" is **not currently reliable as an end-to-end repo-level claim**.

The same pattern appears in NATS:

- The repo contains a strong **per-service ACL design**
- The checked deployment path does **not** prove that all per-service identities are actually provisioned and injected
- The checked Docker NATS TLS config is **server-auth TLS only**, not mTLS

This report separates:

- **Confirmed strengths**
- **Confirmed hardening gaps**
- **Claims that are directionally true but operationally unproven**

---

## Claim Verification Matrix

| Claim | Verdict | Notes |
|---|---|---|
| JWT RS256 asymmetric | Partially true, not certifiable end-to-end | Target architecture is RS256, but auth-service still has HS256 verify path and checked deployment artifacts still rely on `JWT_SECRET` |
| Per-service DB roles | Partially true | Exists in init scripts and root production compose, but dev still uses shared app user and shared grants remain |
| NATS per-service ACL | Design exists, rollout not proven | `nats.conf` defines per-service users and subject ACLs, but checked deployment env wiring does not prove full activation |
| NATS TLS one-way | True for checked Docker production path | Checked NATS TLS file uses `verify: false`, meaning client certs are not required |
| mTLS absent | True for checked Docker production path | Server-side NATS config does not require client certificates |
| Cert rotation absent | Too broad / partly false | Internal transport cert rotation is not evidenced; AWS secret rotation exists for RDS and Redis credentials |
| Secrets management weak / only `.env` | False as a repo-wide statement | Dev is env-heavy, but Helm/K8s/Terraform include External Secrets and AWS Secrets Manager patterns |
| Network isolation good | True in production artifacts, false in dev | Root production compose and Helm network policy are materially stronger than local compose |
| Input validation good | True | Global validation pipe is strong at service boundaries |
| Audit logging good | Broadly true as a capability | Shared infrastructure exists and usage is real, but full write-path completeness is not proven |

---

## Confirmed Strengths

### 1. Boundary Validation Is Strong at the Framework Level

The shared bootstrap config enables:

- `whitelist: true`
- `forbidNonWhitelisted: true`
- `transform: true`
- hidden validation internals
- suppressed detailed validation messages in production

Evidence:

- `libs/backend-common/src/bootstrap/create-service-app.ts:376-426`

This supports the claim that request-boundary validation is materially present and not just ad hoc.

### 2. Audit Logging Infrastructure Is Real

Shared audit infrastructure exists and is not merely aspirational:

- global audit log module
- audit decorator
- interceptor-based logging path
- actual resolver usage in business flows

Evidence:

- `libs/backend-common/src/audit/audit-log.module.ts:8-49`
- `libs/backend-common/src/decorators/audit-log.decorator.ts:28-43`
- `apps/hr-service/src/leave/leave.resolver.ts:246-320`

This supports the claim that audit logging capability exists. It does **not** prove every mutation path is covered.

### 3. Production Network Isolation Is Materially Better Than Dev

The checked root production compose defines an internal-only Docker network:

- `aqua-internal`
- `internal: true`

Evidence:

- `docker-compose.prod.yml:13-18`

The Helm chart also defines default-deny and gateway-only ingress patterns for backend pods.

Evidence:

- `infrastructure/helm/aquaculture/templates/networkpolicy.yaml:1-110`

So "network isolation exists" is fair for production artifacts. It is not fair as a universal statement for all environments.

### 4. Per-Service DB Roles Are Not Fictional

The database init script creates dedicated service roles and grants per-schema privileges.

Evidence:

- `infrastructure/docker/init-scripts/00-init-schemas.sh:179-240`

The checked root production compose also uses per-service database usernames in connection URLs.

Evidence:

- `docker-compose.prod.yml:121`
- `docker-compose.prod.yml:162`
- `docker-compose.prod.yml:188`

This means the architectural claim is grounded in repo reality, even if rollout remains mixed across environments.

---

## Confirmed Hardening Gaps

### 1. JWT Hardening Drift Between Architecture, Shared Libraries, and Deployment

**Severity:** Critical

The repo contains three conflicting JWT stories.

#### A. Target architecture is RS256

Auth-service explicitly states:

- sole token issuer
- RSA key pair required in production
- RS256 signing

Evidence:

- `apps/auth-service/src/app.module.ts:125-233`

Shared verification utilities also require `JWT_PUBLIC_KEY` or `JWT_PUBLIC_KEY_PATH` and enforce `algorithms: ['RS256']`.

Evidence:

- `libs/backend-common/src/auth/jwt-verification.utils.ts:107-170`
- `apps/gateway-api/src/app.module.ts:247-320`
- `apps/gateway-api/src/middleware/jwt.middleware.ts:45-52`

#### B. Active auth-service guard still verifies with HS256

The auth-service global JWT guard currently does:

- `verifyAsync(..., { algorithms: ['HS256'], audience: ... })`

Evidence:

- `apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts:63-69`

This is not a documentation issue. It is checked runtime code.

#### C. Checked deployment artifacts still distribute `JWT_SECRET`

Root production compose injects `JWT_SECRET` into gateway and backend services.

Evidence:

- `docker-compose.prod.yml:121-127`
- `docker-compose.prod.yml:162-168`
- `docker-compose.prod.yml:188-194`

Helm does not spray `JWT_SECRET` to every service. It intentionally excludes it from shared backend env and injects it into auth-service only. However, the checked Helm secret model still centers on `jwtSecret`, while the shared helper comments say non-auth services should use `JWT_PUBLIC_KEY` or auth-service introspection. The checked Helm templates do not show an equally explicit public-key distribution path for consumers.

Evidence:

- `infrastructure/helm/aquaculture/templates/_helpers.tpl:98-122`
- `infrastructure/helm/aquaculture/templates/backend-services.yaml:37-48`
- `infrastructure/helm/aquaculture/templates/secrets.yaml:15-19`

#### Conclusion

The repo shows **JWT migration drift**. It is not safe to summarize the current platform as "cleanly RS256 asymmetric" without first reconciling:

- auth-service guard behavior
- deployment env contract
- Helm secret model

### 2. NATS ACL Design Exists, but Deployment Wiring Does Not Prove Full Isolation

**Severity:** High

The NATS config file contains a serious ACL design:

- per-service users
- subject-level publish permissions
- subject-level subscribe permissions

Evidence:

- `infrastructure/docker/nats/nats.conf:20-60`

However, checked deployment artifacts do not prove full use of that design.

In root production compose:

- NATS container receives `NATS_USER` / `NATS_PASS`
- service containers mostly receive `NATS_AUTH_USER` / `NATS_AUTH_PASS`
- the config file also expects many other service-specific variables such as `NATS_FARM_USER`, `NATS_SENSOR_USER`, `NATS_BILLING_USER`, etc.

Evidence:

- `docker-compose.prod.yml:91-99`
- `docker-compose.prod.yml:123-125`
- `infrastructure/docker/nats/nats.conf:31`
- `infrastructure/docker/nats/nats.conf:55`

In Helm, all backend services are modeled around a single `natsUrl` secret value.

Evidence:

- `infrastructure/helm/aquaculture/values.yaml:392-395`
- `infrastructure/helm/aquaculture/templates/_helpers.tpl:117-121`

#### Conclusion

The right statement is:

- **Per-service ACL capability exists**
- **Operational rollout is not proven by checked manifests**

That is materially weaker than "NATS per-service ACL: iyi".

### 3. Checked Docker Production NATS Uses One-Way TLS, Not mTLS

**Severity:** High

The checked NATS TLS configuration says:

- TLS enabled
- server cert, key, CA configured
- `verify: false`

Evidence:

- `infrastructure/docker/nats/nats-tls-enabled.conf:1-16`

That means:

- clients verify the server if they are configured correctly
- server does **not** require client certificates

So for the checked Docker production path:

- "one-way TLS" is accurate
- "mTLS is absent" is accurate

This should be treated as a **real hardening gap**, not speculation.

### 4. Internal Certificate Lifecycle Is Manual, Not Automated

**Severity:** Medium

The repo contains an internal certificate generation script for:

- CA
- NATS
- Redis
- PostgreSQL

Evidence:

- `infrastructure/docker/scripts/generate-internal-certs.sh:1-58`

What is missing from checked artifacts:

- automatic issuance
- automatic renewal
- cert-manager integration for internal transport certs
- server-side mTLS rollout

This does **not** mean "all cert rotation is absent everywhere". It means:

- internal Docker transport cert lifecycle appears manual

### 5. DB Isolation Is Mixed: Stronger in Production, Weaker in Dev

**Severity:** Medium

The init script explicitly keeps the shared application user for backward compatibility and broad development convenience.

Evidence:

- `infrastructure/docker/init-scripts/00-init-schemas.sh:91-154`

Development compose also wires services to the shared `aquaculture` user rather than per-service credentials.

Evidence:

- `docker-compose.yml:15-18`
- `docker-compose.yml:116-120`

This does not invalidate the per-service role model. It does mean the platform still supports a weaker operating mode.

### 6. Secrets Posture Is Mixed, Not "Only .env"

**Severity:** Medium

The repo clearly supports stronger secret management patterns:

- Kubernetes secret schema without committed values
- External Secrets integration
- AWS Secrets Manager as production secret store in Helm values
- Terraform-managed Secrets Manager resources and rotation for RDS and Redis

Evidence:

- `infrastructure/kubernetes/base/secrets.yaml:1-48`
- `infrastructure/helm/aquaculture/templates/secrets.yaml:22-49`
- `infrastructure/helm/aquaculture/values-production.yaml:96-103`
- `infrastructure/terraform/modules/rds/main.tf:218-246`
- `infrastructure/terraform/modules/elasticache/main.tf:129-155`

However, the local `readSecret()` / `bootstrapSecrets()` helper appears unused in checked application code.

Evidence:

- `libs/backend-common/src/config/secrets.provider.ts`
- no call site found for `bootstrapSecrets(...)`

#### Conclusion

The right summary is:

- secrets maturity is **inconsistent**
- stronger production patterns exist
- local and some deployment paths still lean on env injection
- "only `.env`" is an inaccurate simplification

---

## Environment Split Matters

One reason the earlier table was misleading is that the repo contains materially different postures by environment.

### Development Defaults

- shared DB user
- no internal-only Docker network segmentation
- NATS over `nats://`
- no checked NATS TLS mount

Evidence:

- `docker-compose.yml:11-40`
- `docker-compose.yml:59-77`
- `docker-compose.yml:116-120`

### Checked Docker Production Path

- internal Docker network
- PostgreSQL TLS enabled
- Redis TLS enabled
- NATS TLS enabled
- NATS still not mTLS
- JWT deployment contract still appears HS256-era or transitional

Evidence:

- `docker-compose.prod.yml:13-18`
- `docker-compose.prod.yml:37-55`
- `docker-compose.prod.yml:62-80`
- `docker-compose.prod.yml:82-100`
- `docker-compose.prod.yml:121-127`

### Helm / Kubernetes Target Path

- network policy model exists
- ingress TLS via cert-manager exists
- external secret model exists
- backend env helpers intentionally avoid spraying `JWT_SECRET` to all services

Evidence:

- `infrastructure/helm/aquaculture/templates/networkpolicy.yaml:1-110`
- `infrastructure/kubernetes/base/ingress.yaml:9-34`
- `infrastructure/helm/aquaculture/templates/_helpers.tpl:98-122`
- `infrastructure/helm/aquaculture/templates/secrets.yaml:22-49`

This is why a single-row summary such as "the system is mid-tier SaaS" is too coarse to be decision-grade.

---

## What The Repo Actually Supports Today

### Claims I Would Make Confidently

- Boundary validation is materially implemented.
- Audit logging infrastructure is real.
- Production network isolation patterns exist.
- Dedicated DB roles and schema ownership exist.
- NATS one-way TLS is configured in the checked Docker production path.
- mTLS is not enabled in the checked Docker production path.

### Claims I Would Not Make Without Runtime Verification

- RS256 asymmetric rollout is complete everywhere.
- Per-service NATS ACL is actually active in the running environment.
- Secrets are fully managed by AWS Secrets Manager / Vault in deployed clusters.
- Audit logging covers every mutation path.
- Per-service DB roles are enforced in all non-production and production environments consistently.

---

## Highest-Value Review Conclusions

1. The biggest real problem is **JWT rollout inconsistency**, not merely "missing mTLS".
2. The second biggest issue is **NATS design vs deployment drift**.
3. The security table understated repo maturity on secrets and infrastructure templates, but overstated confidence that those controls are actually live.
4. The repo is not best described as "weak" or "strong". It is better described as **architecturally serious, operationally inconsistent**.

---

## Review-Only Next Checks

If a follow-up review is required, the next highest-signal checks are:

1. Confirm which JWT guard path actually protects auth-service GraphQL and REST in production.
2. Trace whether any deployment path injects `JWT_PUBLIC_KEY` / `JWT_PRIVATE_KEY` today.
3. Verify whether running NATS instances receive the full per-service credential set expected by `nats.conf`.
4. Check whether any live Helm overlay or ArgoCD values reconcile the current JWT and NATS drift.
5. Verify whether internal transport cert renewal is documented outside the repo or truly manual.

These are review tasks only. No remediation is proposed in this document.
