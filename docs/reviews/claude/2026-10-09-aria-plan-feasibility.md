# ARIA plan feasibility: prescribed imports resolve, and a scope refusal re-plans

- **Date:** 2026-10-09
- **Reviewer:** claude (Lane B)
- **Finding:** ARIA-HIGH-397

## ARIA-HIGH-397

The measured case is F-015 on 2026-10-08:

- `plan-cyc-20261008T043925Z-auto` converged with two key changes in `web/modules/hr-module`.
  One prescribed
  `import type { LeaveRequestStatus } from '@platform/shared-ui/generated/graphql-types'`.
- `web/modules/hr-module/tsconfig.json` has no `@platform/shared-ui/*` path alias (sensor-module
  has one). The import cannot resolve.
- The implementer ran the type-check, observed TS2307 and refused with class `scope`. The only
  fix, the alias in the module's tsconfig, lay outside the request's three-file write set, although
  it lay inside the operator's signed write root `web/modules/hr-module`.
- The plan went to HUMAN_REQUIRED. An operator withdrew it and signed a second request by hand.

## The fix, in three parts

### 1. Prescribed imports must resolve before CONVERGED (tier-3 detection at planning time)

- `tools/gates/plan-import-witness.ts` asks the repository's own TypeScript (it refuses any other
  copy) whether a specifier resolves from a file under the project's own `tsconfig.json`
  (`extends` included). The files the plan creates are overlaid on the compiler's file view.
- `aria_kernel/plan_import_resolution.py` reads the specifiers a plan's key changes prescribe
  (`from '…'`, `import '…'`, `import('…')`, `require('…')`) against the key change's own source
  files. It runs the witness inside the round's coverage computation and records an
  `import_resolution` block on `coverage_computed`.
  - Each unresolved specifier becomes a material synthetic risk, `IMP-R{N}-…`, on the same channel
    coverage gaps use, so the next revision addresses it.
- `plan_convergence` adds the gate `prescribed_imports_resolve` to the evaluator.
  - Unresolved: `prescribed_imports_unresolved` (next round, or HUMAN_REQUIRED at max rounds).
  - A body that prescribes imports but was never checked: `prescribed_imports_unchecked`.
  - A witness that could not run: `prescribed_imports_environment_unable`.
  - The last two are HUMAN_REQUIRED at once, fail-closed.
- A plan that changes a project's compiler configuration itself takes the answer on. Its
  specifiers in that project are reported `config_planned` and not judged; the implementation's
  validation suite judges them.
- On the F-015 body, the witness reports `@platform/shared-ui/generated/graphql-types`
  unresolved for `web/modules/hr-module/tsconfig.json`, while sensor-module resolves it.

### 2. A scope refusal inside the signed write roots re-plans, bounded

`aria_kernel/implementation_replan.py`. An implementer refusal of class `scope` or `law`
re-plans only when the kernel establishes all of the following:

- the plan is still waiting on this implementation, and its lineage has re-planned fewer than two
  times;
- the plan came from an operator request whose row the kernel reads from the signed ledger and
  re-verifies against the committed trust anchor, and that row signs `write_roots`;
- at least one enabling surface lies inside those roots, is not kernel-read-only, is not an
  evidence-only surface, and is not already in the write set.

Where a surface comes from:

- the kernel's own measurement: the import witness on the converged body names the project
  configuration of a specifier it does not resolve;
- or the implementer names it in the refusal's new structured `enabling_surfaces`. The kernel
  checks it as a path and nothing more. The implementer's prose never reaches a plan.

What a re-plan does:

- The predecessor ends `implementation_replanned`, fault domain `harness`. Nothing cools off, and
  it is transparent to the loop guard's streak.
- A successor plan, `<first>-rp<N>`, starts from the converged body with each surface as a
  kernel-written key change.
- It binds to the same consumed operator request with its own `synthesis_bound` row
  (`replan_of`), so the merge owner's pre-merge join proves its provenance. A test runs that join
  on the successor.
- The executor's planning lane advances the successor in the same run.

Anything else falls back to HUMAN_REQUIRED as before, with the named reason the re-plan was not
taken (`context.replan`).

Why a successor and not a reopened plan: a converged plan's rounds, independence verdict and
coverage are signed history, and reopening one would rewrite what was agreed.

### 3. The executor budget gap: tracked as ARIA-MEDIUM-398

- An implementation's worst case (20343 s) is 97% of the 21000 s drain budget. A request minted
  mid-run is therefore always window-skipped, and today the next executor runs only after the
  next cycle.
- On 2026-10-09: F-015's request was minted at 07:41Z, the cycle chained at 07:49Z was still
  running at 09:07Z, and the request was still waiting.
- The fix is a bounded drain-to-drain chain edge in the executor workflow, with its own chain-edge
  and workflow-contract pins. It is split out with an owner and a deadline (claude, 2026-10-20)
  rather than folded in here.
