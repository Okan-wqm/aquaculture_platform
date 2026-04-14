# Dependency Graph — Security Hardening Remediation

```mermaid
graph TD
    P01[01-jwt-deployment-contract CRITICAL] --> P07[07-bootstrap-secrets-adoption MEDIUM]
    P02[02-nats-per-service-credentials HIGH] --> P03[03-nats-mtls-enforcement HIGH]
    P03 --> P08[08-cert-manager-internal-issuer MEDIUM]
    P04a[04a-internal-http-signing-lib HIGH] --> P04b[04b-internal-http-callsite-rollout HIGH]
    P05a[05a-rls-session-guc-wiring HIGH] --> P05b[05b-rls-policies-enable HIGH]
    P06[06-pii-log-masking-central HIGH]
    P09[09-dev-db-per-service-wiring MEDIUM]
    P10[10-password-pepper-bcrypt MEDIUM]
    P11[11-secret-leak-prevention MEDIUM]
    P12[12-k8s-pod-security-standards MEDIUM]
    P13[13-structured-json-logging LOW]

    classDef crit fill:#c62828,color:#fff
    classDef high fill:#ef6c00,color:#fff
    classDef med  fill:#fbc02d,color:#000
    classDef low  fill:#9e9e9e,color:#fff
    class P01 crit
    class P02,P03,P04a,P04b,P05a,P05b,P06 high
    class P07,P08,P09,P10,P11,P12 med
    class P13 low
```

## Topological Execution Order

**Tier 0 (zero prerequisites — can run any order):** 01, 02, 04a, 05a, 06, 09, 10, 11, 12, 13
**Tier 1 (unblocked after tier 0):** 03 (after 02), 04b (after 04a), 05b (after 05a), 07 (after 01)
**Tier 2 (unblocked after tier 1):** 08 (after 03)

## Recommended Sequence (phase-aware)

1. **P01** — Unbreaks production. Must ship first.
2. Parallel/sequential within Phase 1: **P02 → P03**, **P04a → P04b**, **P05a → P05b**, **P06**
3. Phase 2: **P07** (after P01), **P08** (after P03), **P09**, **P10**
4. Phase 3: **P11**, **P12**, **P13**

## Cycle Detection
None — graph is acyclic. Kahn's algorithm terminates with all 14 packages emitted.
