# Research: GitHub Actions Supply-Chain Security — SHA Pinning, Minimal Permissions, Trivy Gate

**Topic:** GitHub Actions workflow hardening — full-length SHA pinning (not tags), least-privilege `permissions:`, `timeout-minutes`, secret masking, dependency-review, Trivy scan with exit-code gate, `npm ci --ignore-scripts`, deterministic lockfiles.
**Date:** 2026-04-08
**Agent:** infra-expert

## Sources
- [GitHub Docs: Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [GitHub Docs: Using the GITHUB_TOKEN in a workflow](https://docs.github.com/en/actions/security-guides/automatic-token-authentication)
- [GitHub Docs: Workflow syntax — permissions](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#permissions)
- [GitHub Docs: dependency-review-action](https://github.com/actions/dependency-review-action)
- [OpenSSF Scorecard: Pinned-Dependencies check](https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies)
- [Aqua Security: Trivy GitHub Action](https://github.com/aquasecurity/trivy-action)
- [Snyk: Trivy GitHub Actions Supply Chain Compromise (2026-03)](https://snyk.io/articles/trivy-github-actions-supply-chain-compromise/)
- [The Hacker News: Trivy Security Scanner GitHub Actions Breached, 75 Tags Hijacked (2026-03)](https://thehackernews.com/2026/03/trivy-security-scanner-github-actions.html)
- [Microsoft Security Blog: Defending against the Trivy supply chain compromise](https://www.microsoft.com/en-us/security/blog/2026/03/24/detecting-investigating-defending-against-trivy-supply-chain-compromise/)
- [StepSecurity: Secure-repo best practices](https://app.stepsecurity.io/secureworkflow/)
- [npm Docs: npm ci --ignore-scripts](https://docs.npmjs.com/cli/v10/commands/npm-ci)

## Key Findings

1. **SHA pinning is the ONLY supply-chain-safe action reference.** The March 2026 `aquasecurity/trivy-action` compromise force-pushed malicious commits to 75 of 76 version tags, silently exfiltrating CI secrets while the scan appeared to run normally. Tags are mutable; only full-length (40-char) commit SHAs are immutable. `uses: actions/checkout@v4` = CRITICAL. `uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2` = correct.
2. **Pin ALL third-party actions, not just "risky" ones.** The 2021-2026 attack pattern consistently targets popular actions (codecov, tj-actions/changed-files, reviewdog, Trivy). Assume any action can be compromised. First-party `actions/*` from the `actions` org are lower risk but still subject to tag mutability — pin them too.
3. **Minimal permissions per workflow and per job.** Default `GITHUB_TOKEN` has write permissions across many scopes. Declare `permissions: { contents: read }` at the top of every workflow as the default; expand only on the specific job that needs `security-events: write` (CodeQL/Trivy SARIF), `pull-requests: write` (comments), or `packages: write` (registry push). Missing `permissions:` = HIGH.
4. **`timeout-minutes` on every job.** Absent default is 360 minutes (6 hours). A hung job burns runner minutes and delays queue. Every job MUST set `timeout-minutes: <reasonable>` (build: 20, test: 30, deploy: 45). Missing = MEDIUM.
5. **Secret masking.** GitHub auto-masks secrets stored in `secrets.*` but values derived at runtime (e.g., decoded base64, API response) need explicit `echo "::add-mask::$VALUE"`. Echoing secrets unmasked = CRITICAL.
6. **Dependency review action on every PR.** `actions/dependency-review-action@<sha>` with `fail-on-severity: moderate` blocks PRs introducing vulnerable dependencies before merge. Missing on PR workflow = HIGH.
7. **Trivy scan with `exit-code: '1'` on HIGH/CRITICAL.** Scan without fail-gate = warning-only, findings ignored. Trivy config MUST be: `severity: 'CRITICAL,HIGH'`, `exit-code: '1'`, `ignore-unfixed: true`. Filesystem scan on every push, image scan on every image push + weekly cron. Non-gating scan = MEDIUM.
8. **`npm ci --ignore-scripts` in CI.** Post-install scripts are the #1 vector for malicious dependency execution (e.g., event-stream 2018, colors.js 2022). `--ignore-scripts` prevents arbitrary code execution during install. Required in CI. For apps that legitimately need post-install (native builds), allowlist specific packages via `npm rebuild <allowlisted>`.
9. **`package-lock.json` committed and used by `npm ci`, not `npm install`.** `npm install` can upgrade deps silently; `npm ci` refuses to run without a lockfile and errors on drift. Missing lockfile = HIGH.
10. **`persist-credentials: false` on actions/checkout.** Default `true` leaves a git credential file with GITHUB_TOKEN on disk accessible to subsequent steps; a compromised step can use it to push. Set `false` unless the job actually needs to push.
11. **Disable workflow_run and pull_request_target without scrutiny.** `pull_request_target` runs with write token on forks — a footgun. Use `pull_request` for PR CI; reserve `pull_request_target` for trusted automation only.
12. **Dependabot or Renovate for action SHA upkeep.** Manual SHA rotation is impractical across 18 workflows. Configure Dependabot `package-ecosystem: "github-actions"` weekly.

## Security Concerns
- Any action referenced by tag (`@v4`, `@main`, `@latest`) = CRITICAL.
- Workflow with no top-level `permissions:` = HIGH.
- Job missing `timeout-minutes` = MEDIUM.
- Trivy scan without `exit-code: '1'` = MEDIUM → HIGH in production workflows.
- Missing dependency-review-action on PR workflow = HIGH.
- `npm install` in CI (should be `npm ci`) = HIGH.
- `npm ci` without `--ignore-scripts` = HIGH.
- `actions/checkout` with `persist-credentials: true` (default) on jobs that don't push = MEDIUM.
- `pull_request_target` handling forked PR code with write token = CRITICAL.
- Secret echoed to logs without `::add-mask::` = CRITICAL.
- Missing `package-lock.json` = HIGH.
- Third-party action from unknown org without pinning to SHA = CRITICAL.

## Performance Concerns
- Missing `paths:` filter on workflows causes unnecessary runs = LOW.
- Missing action cache (`actions/cache`) for npm/pnpm/yarn = MEDIUM.
- Sequential jobs that could run in parallel via `needs:` graph = LOW.
- No concurrency group → duplicate runs on rapid pushes = LOW.

## Architectural Implications for infra-expert reviews
- SHA pinning is NON-NEGOTIABLE for every `uses:` reference. Flag every tag-referenced action as CRITICAL.
- Default `permissions: { contents: read }` must appear at the top of every workflow.
- Every job needs `timeout-minutes`.
- Trivy MUST have `exit-code: '1'` gate; anything weaker is a paper scan.
- `npm ci --ignore-scripts` is the minimum bar for Node.js CI.
- Dependabot config for `github-actions` ecosystem is required for sustainable SHA rotation.

## Domain Rule Additions for infra-expert

Add to `## Domain Rules → CI/CD (Critical)`:
- Every `uses:` reference MUST pin to a full 40-char commit SHA with a version comment (`@<sha> # v4.2.2`); tag references = CRITICAL.
- Every workflow MUST declare `permissions:` at the top-level (read-only default) and expand only per-job where needed; missing = HIGH.
- Every job MUST set `timeout-minutes`; missing = MEDIUM.
- Trivy scans MUST set `exit-code: '1'`, `severity: 'CRITICAL,HIGH'`, `ignore-unfixed: true`; non-gating scan = HIGH.
- Dependency review MUST be enabled on all PR workflows with `fail-on-severity: moderate`; missing = HIGH.
- CI MUST use `npm ci --ignore-scripts` (or equivalent for pnpm/yarn); `npm install` in CI or missing `--ignore-scripts` = HIGH.
- `actions/checkout` MUST set `persist-credentials: false` unless the job needs to push; default-true on non-push jobs = MEDIUM.
- `pull_request_target` with checkout of untrusted fork code = CRITICAL.
- Dependabot config for `github-actions` ecosystem MUST be present; missing = MEDIUM.
- Secrets derived at runtime MUST be masked with `::add-mask::`; unmasked = CRITICAL.
