# Package 11: secret-leak-prevention

## Metadata
Status: DONE (commit TBD)
Estimated Tokens: 4K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes (tier 0)
Prerequisites: none
Closing-Findings: [MEDIUM-005]
Source-Reviews: /var/aqua-saas/docs/security/2026-04-12-hardening-gap-report.md (2026-04-14 gap scan #11)

## Context
No pre-commit hook, no CI gitleaks scan. Accidental commits of `.env` files, PEM keys, or API tokens would only be caught by manual review. This package adds gitleaks at both pre-commit and CI layers with a curated rule pack and allowlist for known-safe paths (example envs, plan docs, test fixtures).

## Affected Files
- /var/aqua-saas/.gitleaks.toml (NEW)
- /var/aqua-saas/.pre-commit-config.yaml (NEW)
- /var/aqua-saas/.github/workflows/security-gitleaks.yml (NEW)

## Atomic Commit Plan

```
chore(security): add gitleaks pre-commit hook and CI scan

Two-layer secret-leak prevention:
- .pre-commit-config.yaml: gitleaks protect --staged runs on every commit
  before the diff leaves the dev machine. Supplementary hooks for large
  files, private keys, and merge conflicts.
- .github/workflows/security-gitleaks.yml: CI safety net on push to main
  and every PR. Full-history scan with actions pinned to SHA per SEC-CI-002.
- .gitleaks.toml: inherits gitleaks' default rule pack plus a platform-
  specific rule for high-entropy assignments to JWT/INTERNAL_SERVICE/
  NATS/Stripe/etc env vars. Allowlist covers .env.example, lockfiles,
  docs/plans, test fixtures — paths where pattern matches are expected.

Closes: docs/security/2026-04-12-hardening-gap-report.md#MEDIUM-005
```

## Test Plan
- `gitleaks detect --config .gitleaks.toml --source . --no-git` should emit zero leaks on current main
- CI workflow YAML parses cleanly

## Verification Command
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/security-gitleaks.yml').read())"

## Rollback Plan
`git revert {commit_hash} --no-edit`

## Failure Notes
_(empty)_
