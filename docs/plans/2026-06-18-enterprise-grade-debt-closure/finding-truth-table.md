# Finding Truth Table

Created: 2026-06-18

Registry tip: `6b3454a89b58db52c3f27d8187613c2a2b5b444060763dc4a8ad7c401eba0f42`

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

| Finding                   | Registry state | First sprint | Owner                    | Truth bucket |
| ------------------------- | -------------- | ------------ | ------------------------ | ------------ |
| `COMPLIANCE-CRITICAL-001` | OPEN           | 2.2          | compliance-expert        | real-open    |
| `INFRA-CRITICAL-001`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-006`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-007`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-008`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-010`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-011`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open    |
| `INFRA-CRITICAL-012`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open    |
| `INFRA-CRITICAL-009`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-014`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open    |
| `INFRA-CRITICAL-015`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-017`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-018`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-019`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-020`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open    |
| `INFRA-CRITICAL-021`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-023`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-024`      | IN-PROGRESS    | 1.1          | infra-expert             | real-open    |
| `INFRA-CRITICAL-025`      | IN-PROGRESS    | 1.1          | messaging-expert         | real-open    |
| `INFRA-CRITICAL-026`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-027`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-028`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-029`      | OPEN           | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-030`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-031`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `INFRA-CRITICAL-032`      | IN-PROGRESS    | 1.1          | data-expert              | real-open    |
| `MSG-CRITICAL-050`        | OPEN           | 3.1          | realtime-sync-auditor    | real-open    |
| `MSG-CRITICAL-051`        | OPEN           | 3.1          | realtime-sync-auditor    | real-open    |
| `MSG-CRITICAL-052`        | OPEN           | 3.1          | file-transfer-auditor    | real-open    |
| `MSG-CRITICAL-053`        | OPEN           | 3.1          | file-transfer-auditor    | real-open    |
| `FE-CRITICAL-050`         | OPEN           | 3.1          | frontend-expert          | real-open    |
| `MSG-CRITICAL-054`        | OPEN           | 3.1          | form-write-auditor       | real-open    |
| `FARM-CRITICAL-050`       | OPEN           | 4.1          | workflow-state-auditor   | real-open    |
| `FARM-CRITICAL-001`       | IN-PROGRESS    | 4.1          | multi-tenant-saas-expert | real-open    |

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

No active CRITICAL finding remains in `already-fixed-needs-close` after the
2026-06-18 Wave 0 registry reconciliation. Reconciled items moved to
`Resolved Evidence`.

## Resolved Evidence

- `CLAUDE-CRITICAL-004`: registry state is `RESOLVED` with closing commit
  `7414faac`. `npx jest --config tests/invariants/jest.config.ts
tests/invariants/agent-ownership-uniqueness.spec.ts
tests/invariants/orchestrator-routing-coverage.spec.ts --runInBand` passed on
  2026-06-18, proving routing-table duplicate-primary and ownership conflicts
  stay mechanically guarded.
- `CLAUDE-CRITICAL-005`: registry state is `RESOLVED` with closing commit
  `7414faac`. The same routing coverage run passed 75/75 tests, including the
  reverse roster reachability checks that keep Lane-B agents dispatchable.
- `CLAUDE-CRITICAL-006`: registry state is `RESOLVED` with closing commit
  `00995511`. `npx jest --config tests/invariants/jest.config.ts
tests/invariants/agent-frontmatter-schema.spec.ts --runInBand` passed 421/421,
  proving every discovered active agent carries `tools:` frontmatter from the
  allowed token set.
- `EDGE-CRITICAL-001`: registry state is `RESOLVED` with closing commit
  `d792f74ac`. Repository-local CI coverage exists in
  `.github/workflows/ci-affected.yml`; the required-check SSOT is
  `.github/manifests/main-required-status-checks.json`; static enforcement
  passes through `npm run gates:required-status-checks`. On 2026-06-18, GitHub
  branch protection for `main` was updated from absent to strict required status
  checks with administrator enforcement, and
  `npm run gates:required-status-checks:live` passed, proving
  `sens-enterprise-summary` and `merge-gate` are required.
- `ORPHAN-CRITICAL-094`: registry state is `RESOLVED` with closing commit
  `1a51b1d4`. `npx jest --config libs/backend-common/jest.config.ts
libs/backend-common/src/utils/__tests__/service-identity.util.spec.ts
--runInBand` passed 24/24 on 2026-06-18, including the #388 policy-less keyring
  regression test that accepts catalog callers and rejects unknown callers.
- `MT-CRITICAL-050`: registry state is `RESOLVED` with closing commit
  `93b7d3df`. `npx vitest run --config vitest.config.ts
src/hooks/__tests__/useAuth-logout-wipe.spec.tsx
src/components/__tests__/IdentityBoundary.spec.tsx
src/pwa/__tests__/offline-queue.spec.ts` passed 68/68 on 2026-06-18, proving
  logout awaits persistent wipe, clears tenant React Query cache, and remounts
  authenticated UI on identity switch.
- `MT-CRITICAL-051`: registry state is `RESOLVED` with closing commit
  `93b7d3df`. The same AquaMobil Vitest run passed the user-scoped offline-cache
  regressions, proving user-private schedule/cache data is keyed by tenant and
  user rather than tenant only.
