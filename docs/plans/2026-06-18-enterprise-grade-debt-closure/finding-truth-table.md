# Finding Truth Table

Created: 2026-06-18

Registry tip: `a6a91280560ecb68b6982a6a4e45a2b2e21fb6365d3e17ff8a69286c67828055`

This is the Wave 0 truth table for active CRITICAL findings. The initial rule is
conservative: every non-RESOLVED CRITICAL registry entry is treated as
`real-open` until code, tests, and registry evidence prove a different bucket.

Allowed truth buckets:

- `real-open`
- `already-fixed-needs-close`
- `superseded`
- `blocked`
- `stale`
- `new-finding-required`

| Finding                   | Registry state | First sprint | Owner                    | Truth bucket              |
| ------------------------- | -------------- | ------------ | ------------------------ | ------------------------- |
| `COMPLIANCE-CRITICAL-001` | OPEN           | 2.2          | compliance-expert        | real-open                 |
| `CLAUDE-CRITICAL-004`     | OPEN           | 0.1          | prompt-writer            | already-fixed-needs-close |
| `CLAUDE-CRITICAL-005`     | OPEN           | 0.1          | prompt-writer            | already-fixed-needs-close |
| `CLAUDE-CRITICAL-006`     | OPEN           | 0.1          | prompt-writer            | already-fixed-needs-close |
| `INFRA-CRITICAL-001`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open                 |
| `INFRA-CRITICAL-006`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-007`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-008`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open                 |
| `INFRA-CRITICAL-010`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open                 |
| `INFRA-CRITICAL-011`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open                 |
| `INFRA-CRITICAL-012`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open                 |
| `INFRA-CRITICAL-009`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-014`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open                 |
| `INFRA-CRITICAL-015`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open                 |
| `INFRA-CRITICAL-017`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open                 |
| `INFRA-CRITICAL-018`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open                 |
| `INFRA-CRITICAL-019`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-020`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open                 |
| `INFRA-CRITICAL-021`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-023`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-024`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open                 |
| `INFRA-CRITICAL-025`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open                 |
| `INFRA-CRITICAL-026`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-027`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-028`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-029`      | OPEN           | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-030`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-031`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `INFRA-CRITICAL-032`      | IN-PROGRESS    | 1.1          | data-expert              | real-open                 |
| `ORPHAN-CRITICAL-094`     | OPEN           | 1.2          | auth-security-expert     | already-fixed-needs-close |
| `MSG-CRITICAL-050`        | OPEN           | 3.1          | realtime-sync-auditor    | real-open                 |
| `MSG-CRITICAL-051`        | OPEN           | 3.1          | realtime-sync-auditor    | real-open                 |
| `MSG-CRITICAL-052`        | OPEN           | 3.1          | file-transfer-auditor    | real-open                 |
| `MSG-CRITICAL-053`        | OPEN           | 3.1          | file-transfer-auditor    | real-open                 |
| `FE-CRITICAL-050`         | OPEN           | 3.1          | frontend-expert          | real-open                 |
| `MSG-CRITICAL-054`        | OPEN           | 3.1          | form-write-auditor       | real-open                 |
| `MT-CRITICAL-050`         | OPEN           | 2.1          | tenant-isolation-auditor | real-open                 |
| `MT-CRITICAL-051`         | OPEN           | 2.1          | mobile-app-auditor       | real-open                 |
| `FARM-CRITICAL-050`       | OPEN           | 4.1          | workflow-state-auditor   | real-open                 |
| `FARM-CRITICAL-001`       | IN-PROGRESS    | 4.1          | multi-tenant-saas-expert | real-open                 |

## Mutation Rules

- Change a row out of `real-open` only with a linked code/test/registry proof.
- `already-fixed-needs-close` requires a reproducible command or source proof
  and a planned registry CLI close operation.
- `superseded` requires a successor finding ID or `override_of` chain.
- `blocked` requires owner, external condition, and deadline evidence.
- `stale` requires a registry sweep rule or explicit context-manager review.
- `new-finding-required` is for evidence discovered during implementation that
  is not covered by the existing finding title/rule.

## Already-Fixed Evidence

- `CLAUDE-CRITICAL-004`: `npm run invariants:fast` passes
  `tests/invariants/orchestrator-routing-coverage.spec.ts`; the active routing
  table has one `apps/*/src/gdpr/**` implementation row.
- `CLAUDE-CRITICAL-005`: `npm run invariants:fast` passes the routing reverse
  coverage checks; Lane-B/product-audit agents are reachable or explicitly
  modeled by dispatch metadata.
- `CLAUDE-CRITICAL-006`: `npm run invariants:fast` passes
  `tests/invariants/agent-frontmatter-schema.spec.ts`; agent files carry
  `tools:` frontmatter from the allowed tool set.
- `ORPHAN-CRITICAL-094`: `npx jest --config libs/backend-common/jest.config.ts
libs/backend-common/src/utils/__tests__/service-identity.util.spec.ts
--runInBand` passes 24/24, including the #388 policy-less keyring regression
  test that accepts catalog callers and rejects unknown callers.

## Resolved Evidence

- `EDGE-CRITICAL-001`: registry state is `RESOLVED` with closing commit
  `d792f74ac`. Repository-local CI coverage exists in
  `.github/workflows/ci-affected.yml`; the required-check SSOT is
  `.github/manifests/main-required-status-checks.json`; static enforcement
  passes through `npm run gates:required-status-checks`. On 2026-06-18, GitHub
  branch protection for `main` was updated from absent to strict required status
  checks, and `npm run gates:required-status-checks:live` passed, proving
  `sens-enterprise-summary` and `merge-gate` are required.
