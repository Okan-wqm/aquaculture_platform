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

## Review corrections (adversarial review of #1908)

- **HIGH-1, closed: round 1 judged the challenger.** The coverage closure measures the challenger
  in round 1, but the primary is what converges and is implemented. The import check now runs in
  the drainer on the body that would converge (`plan_import_resolution.import_resolution_for_round`
  on the latest revision). Its block names that revision, and the gate counts a block naming any
  other body as unchecked (HUMAN_REQUIRED). The reviewer's probe, a primary carrying the F-015
  specifier beside a clean challenger, no longer converges.
- **HIGH-2, closed: prose was parsed as imports.** A key change now declares its imports as data:
  `imports: [{from_path, specifier}]`, a new field of the closed key-change shape
  (`KEY_CHANGE_FIELDS`). The plan contract tells every planner. Nothing is parsed out of a
  description, so "from 'PENDING' to 'APPROVED'", a removed import and "do not import" name nothing.
- **HIGH-3, closed: cross-stack key changes.** Each import is bound to one of its change's own
  source files and judged only from that file.
- **HIGH-4, closed: valid frontend imports.**
  - Asset specifiers (non-code extensions, `?query`) are the bundler's and are not judged.
  - An ambient `declare module` of the project's own declaration files resolves (the Module
    Federation remotes in `web/shell`).
  - The project is the one that compiles the file: the nearest `tsconfig.json`, or the project
    it references whose file set holds the file (`apps/*/tsconfig.app.json`).
- **MEDIUM-HIGH-5, closed: `config_planned`.**
  - Only files the key changes write are planned. A config listed only in `affected_surfaces` is
    not the plan's.
  - The whole `extends` chain counts: an alias added to `tsconfig.base.json` is the plan's to make
    true.
  - The IMP risk and the re-plan's kernel surface name the config that declares
    `compilerOptions.paths` (`paths_config`), where an alias belongs.
- **Should-fix 6–9, closed.**
  - The successor starts first. The predecessor is settled only once the successor exists, and a
    settlement another writer won abandons the successor.
  - The lineage is counted from the durable `replan_of` bindings, which name the successor before
    it starts.
  - An enabling surface must be a tracked file strictly inside a root: no directory, no root
    itself, nothing gitignored, and containment by path parts, so a sibling prefix is outside.
  - The witness overlays only the key changes' files, never under `node_modules`, with path
    containment.
- **Tests:**
  - every probe above;
  - the executor's re-planned terminal (`_close_replanned_refusal`: the claim released
    `agent_refused:scope`, the request CANCELLED, no HUMAN_REQUIRED);
  - a request signed by a key the anchor does not hold, named `operator_request_unverified:…`.
