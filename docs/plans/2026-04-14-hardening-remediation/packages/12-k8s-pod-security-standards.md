# Package 12: k8s-pod-security-standards

## Metadata
Status: DONE (commit TBD)
Estimated Tokens: 3K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes (tier 0)
Prerequisites: none
Closing-Findings: [MEDIUM-006]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md (2026-04-14 gap scan #12)

## Context
The namespace had no Pod Security Standards admission labels. Kubernetes 1.25+ ships a built-in PSS admission controller that rejects non-compliant pods — enabling it is a single-labels change, no webhook, no add-on. The platform's existing `securityContext` helper already produces pods that satisfy the `restricted` profile, so the change is purely enforcement.

## Findings
**MEDIUM-006** (2026-04-14 gap scan #12): No K8s Pod Security Standards labels.

## Affected Files
- /var/aqua-saas/infrastructure/helm/aquaculture/templates/namespace.yaml (add PSS labels)
- /var/aqua-saas/infrastructure/helm/aquaculture/values.yaml (new `podSecurityStandards` section)

## Atomic Commit Plan

```
feat(k8s): enforce restricted Pod Security Standards on namespace

Apply pod-security.kubernetes.io/{enforce,audit,warn}=restricted labels
to the application namespace so the built-in admission controller
rejects any pod that violates runAsNonRoot, readOnlyRootFilesystem,
capability drop, or seccomp=RuntimeDefault. The platform's shared
aquaculture.securityContext helper already produces compliant pods —
this change is pure enforcement, no workload changes required.

Profile and version are configurable via values.yaml podSecurityStandards
section (defaults: restricted + latest on all three labels). Operators
who need a baseline-only escape hatch for a specific deployment can
override per-namespace by layering a second namespace with the relaxed
labels and scoping the workload via NetworkPolicy.

Closes: docs/security/2026-04-12-hardening-gap-report.md#MEDIUM-006
```

## Test Plan
- `helm template` renders the namespace with the 6 new labels
- YAML parses cleanly
- Existing deployments render unchanged (securityContext already satisfies restricted)

## Verification Command
YAML parse on values.yaml + namespace.yaml

## Rollback Plan
`git revert {commit_hash} --no-edit`

## Failure Notes
_(empty)_
