# aria-readiness-claim — claims rejected since build-status joined the manifest

**Date:** 2026-08-31 · **Agent:** zcode · **Cycle:** 2026-08-31 branch-recovery
**Finding:** ARIA-MEDIUM-036 · **State:** OPEN → closed by this change

## Symptom

The `aria-readiness-claim` workflow has failed on `main` since 2026-08-31 04:42
(repeated `workflow_run`-triggered runs), rejecting every enterprise-readiness
claim with:

```text
enterprise_readiness_claim_rejected:
  branch_protection_exact_required_checks_mismatch;
  branch_protection_required_checks_mismatch
```

Earlier failures in the same loop also named the protection posture gaps
(signed commits, reviews, conversation resolution, ruleset ids), which are
repository-settings items addressed separately after this kernel fix.

## Root cause

`REQUIRED_MERGE_STATUS_CHECKS` in
`aria-kernel/aria_kernel/enterprise_readiness.py` hard-codes three contexts
(`sens-enterprise-summary`, `merge-gate`, `aria-merge-authority`). The governed
manifest `.github/manifests/main-required-status-checks.json` — the SSOT, whose
findings include INFRA-HIGH-084 — carries **four**, adding `build-status`. The
kernel tuple duplicated the manifest instead of mirroring it, so once
INFRA-HIGH-084 landed the kernel began rejecting the repository's own correct
protection configuration.

## Fix

- The kernel tuple now carries `build-status` and cites the manifest as the
  authority it mirrors.
- Test fixtures (`test_enterprise_readiness_and_genesis_lifecycle.py`,
  `test_auto_merge.py`) imported the constant instead of re-hard-coding three
  literal contexts, so the next manifest addition cannot silently desync the
  suite again.

## Verification

- `aria-kernel` affected suites: 61 tests + 9 subtests green
  (branch-protection proofs, enterprise readiness lifecycle, auto-merge).

## Closes

ARIA-MEDIUM-036
