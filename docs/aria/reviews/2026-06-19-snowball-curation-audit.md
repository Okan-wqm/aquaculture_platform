# Snowball SSOT Curation Record

Date: 2026-06-19

Base audited: `origin/main` at `8c51f74fa`
Legacy source: `snowball` at `e1a1e30c1`
Aggregate source: `codex/snowball-main-safe-20260530` at `75d280aa8`

## Decision

Do not merge either snowball branch directly into `main`.

The legacy `snowball` branch contains 156 non-main commits. The aggregate branch compresses the
runtime work into one commit, but its direct diff against current `origin/main` would remove current
ARIA authority files and runtime contracts, including:

- `docs/aria/ARCHITECTURE.md`
- `docs/aria/ENTERPRISE_AUTONOMY_SSOT.md`
- `docs/aria/runtime-artifact-contract.md`
- `docs/aria/runbooks/runtime-retention.md`
- `docs/aria/schemas/autonomy-burn-in-report.schema.json`
- `aria-kernel/aria_kernel/burn_in.py`
- `aria-kernel/aria_kernel/merge_authority.py`
- `aria-kernel/aria_kernel/runtime_artifacts.py`
- `aria-kernel/aria_kernel/runtime_profile.py`
- `aria-kernel/aria_kernel/state_manifest.py`

Those 10 current-main authority surfaces account for a direct `origin/main..snowball` delta of
`158 insertions, 3257 deletions`. That is a regression signal, not an integration path.

## SSOT Integration Contract

`docs/aria/CURRENT_STATE.md`, executable contracts, and machine-checked invariants remain the only
current ARIA authority. Snowball is evidence, not a second architecture line.

Every future snowball-derived change must satisfy this sequence:

1. Prove the gap against the current authority surface listed in `docs/aria/CURRENT_STATE.md`.
2. Integrate the value through the existing owner module, contract, or generated SSoT artifact.
3. Reject any duplicate module, duplicate schema, duplicate CLI path, or duplicate prose authority.
4. Remove or mark obsolete legacy material when it conflicts with the owner surface.
5. Add or update the invariant that prevents the duplicate from returning.

No snowball commit can bypass this contract by preserving its historical file layout. If the value is
real, it must become part of the current owner surface. If the current owner surface already provides
the value, the snowball commit is closed as evidence only.

## Duplicate And Cleanup Gate

For each import lane, the reviewer must inspect the current-main owner surface and the snowball
source surface together. Acceptance requires a written outcome for each of these classes:

- Owner module: keep exactly one runtime owner for the behavior.
- Contract/schema: keep exactly one machine-checked contract or generated artifact.
- CLI/API surface: keep exactly one live entry point; legacy aliases must be explicit compatibility
  shims with tests or removed.
- Runtime state: generated `aria-tools/**`, `aria-kernel/aria-tools/**`, and stale
  `aria-findings/**` files are not importable.
- Documentation: lower-priority prose must defer to `CURRENT_STATE.md` or be marked historical.
- Tests: imported value must be guarded by current-main invariant tests, not only by snowball-era
  reports.

## Value Gate

Decision labels:

- `KEEP-MAIN`: value exists, but current `main` already carries the safer or newer authority. Do not
  cherry-pick the snowball commit.
- `SSOT-GAP-CANDIDATE`: value exists and may justify a controlled architecture PR only after direct
  parity review proves a gap in the current-main owner surface. The implementation must modify the
  owner surface, clean conflicting legacy/duplicate surfaces, and add an invariant.
- `NO-IMPORT-STATE`: runtime state, generated discovery output, finding ledger churn, or captured
  execution output. Do not commit it to `main`.
- `NO-IMPORT-MERGE`: merge-only or broad branch reconciliation commit. Do not replay it.

Current audit defaults:

- Generated `aria-tools/**`, `aria-kernel/aria-tools/**`, and stale `aria-findings/**` state is
  `NO-IMPORT-STATE`.
- Snowball code that would delete newer current-main authority is not directly portable.
- Runtime enablement must remain fail-closed: no live action, no autonomous merge, no external write
  path can become enabled by importing snowball code.
- A duplicated snowball subsystem is never accepted beside a current-main subsystem. The outcome is
  either owner-surface integration or rejection.

## Commit Ledger

| Decision | Commits | Change read | Rationale |
|---|---|---|---|
| `KEEP-MAIN` | `534956cc7`, `d1313b29b`, `41737a7f8`, `33686d177`, `b21a59c8e`, `f2f0909f4`, `696816f96`, `3b374b744`, `7dc3326f3`, `d16589c0a` | V2 registry compiler, root binding, migration, FATES snapshot, MFE discovery, excluded-path sharing, state cleanup, CI hygiene, report generation. | Current main has newer runtime artifact, tool registry, state manifest, discovery, and CI surfaces. The generated state deletions in `3b374b744` are policy-aligned but not imported as branch history. |
| `KEEP-MAIN` | `e776f67aa`, `f53b0623d`, `3212e31b6`, `38bb7f13e`, `4716b4898`, `aaf8a1a67`, `f4990fcba`, `cf30da506`, `1c9624d08`, `7952b3855`, `1aa6905a2`, `10e601a9d` | V3 preflight, required adapter injection, draft validation, ack ledger, auto-action gate, cost circuit breaker, workflow hygiene, autonomous profile, lock and breaker primitives, ADR-033 update. | Main already has these concepts in stricter form through current `runtime_profile.py`, `merge_authority.py`, `runtime_artifacts.py`, and enterprise autonomy docs. Direct snowball replay would regress those files. |
| `KEEP-MAIN` | `ef8a30c42`, `ba423d0a3` | V3.1 CLI import cleanup and filesystem-backed finding/debt aggregation. | Useful behavior, but main has the current ARIA kernel and finding registry shape. Reapply only if a parity test proves a missing current-main invariant. |
| `NO-IMPORT-STATE` | `bfe71aabf` | Finding state transition only. | Historical finding ledger update, not runtime behavior. |
| `KEEP-MAIN` | `b8447acd5`, `287baacb3`, `664af7937`, `c865b255a`, `5b88522aa` | Agent pedagogy registry, narrative prompt validator, inter-agent question envelope, planner/agent prompt shape. | Main has later prompt consolidation and pedagogy enforcement. Direct import would conflict with current agent contract work. |
| `KEEP-MAIN` | `0abc2eba5`, `6f5158950`, `7a6d3a84d`, `82292d69c`, `aa18ee626` | V3.2 cycle-bound discovery events, reflection path invariants, belief freshness, replay invariants, reflection ordering correction. | Valuable invariants, but current main has later runtime state and reflection surfaces. Treat as parity evidence, not cherry-pick input. |
| `NO-IMPORT-STATE` | `6743c61e8`, `c5022288a`, `e1c57d655`, `c78ba8cdb` | Orphan/finding documentation updates. | Historical ledger narrative. No active code import. |
| `KEEP-MAIN` | `9855116f1`, `b892ef09e` | Tools-dir ownership rewrite and post-drain reflection ordering. | Main has current clean-trial and runtime artifact rules. Replaying these commits would carry obsolete state-root assumptions. |
| `KEEP-MAIN` | `bed186d53`, `a16744bce`, `11eaea1c1`, `19b00d1b1`, `35d985b27`, `43ef66d50`, `d1588647c` | Convergence drainer, review gate, telemetry, specialist gate, plan synthesizer, invalid-plan handling, real-field forwarding. | Main contains a newer convergence and orchestrator surface. These commits remain evidence for owner-surface regression tests. |
| `SSOT-GAP-CANDIDATE` | `a58f0cb74`, `d8dd818e0`, `5b2686465`, `8c5cfb47d`, `4ebfde81d`, `1ecee46ae`, `fcb219e6d`, `328dbb1bf`, `d87c2dba2`, `da438761e`, `8986f4ebf`, `38a557c39`, `ad7171b52` | Pedagogy universalization, convergent skill authoring, seed invariants, calibration bootstrap, V6/V7 CI wiring, dispatcher factories, skill-genesis drainer, corpus and watchdog controls. | Valuable themes. Review as an agent-contract/convergence architecture PR only if a current owner gap is proven; keep current-main authority files and reject generated state. |
| `SSOT-GAP-CANDIDATE` | `66dd0faae`, `45ed0f4e1`, `e401ac5c6`, `347b1701e`, `e1183e4d3`, `f74ee9b6b`, `e57facb49`, `f32a0a055`, `fb4680118`, `ae7877833` | `tools/aria-poc/ci_executor.py` and worker executor shape: Codex CLI argv, envelope rendering, plan normalizers, refusal handling, satisfaction matrix repairs, API backoff subprocess wiring. | Executor behavior is high-value but risky. Compare directly against current `tools/aria-poc/*`; integrate only missing owner behavior under dry-run defaults and delete any duplicate path created by the import. |
| `NO-IMPORT-STATE` | `b66db4f56`, `89f48d4f7`, `f9af513ab`, `74af7f8be`, `7e88049e7`, `71097b848`, `c9f1b49a5` | Registry, orphan, and finding bookkeeping. | Finding history does not create current runtime value by itself. |
| `KEEP-MAIN` | `3823a80c8`, `43e728520`, `5cf200b87`, `de7a4645c`, `42fb68e60`, `edfb9c738`, `4d1d68a87`, `f96c52492`, `81beccf17`, `53be1f3c7`, `162b09705`, `4a2ff7274`, `65c933e1d`, `18309046d`, `a39a28fa9`, `850975f99`, `fb0baa50c`, `5dc821393`, `dde422d58`, `edc7cea3f`, `ee9c60263`, `83733046b` | V8/V9 convergence, bridge safety, regex ReDoS fix, evidence refs, drainer text selection, canonical envelope, state machine hardening. | Main has later bridge, agent, and runtime surfaces. These commits are useful as regression-test source material, not as direct code import. |
| `NO-IMPORT-STATE` | `c43998431`, `3c5d4abf0`, `b2572e7a2`, `00b221aad`, `6aae61443`, `f8dda69ce` | CI timeout tuning, architecture/history docs, smoke reports, ADR recommendation drafts, closure report. | Keep only if a current-main doc gap is proven. Do not import snowball wording over current ARIA authority docs. |
| `KEEP-MAIN` | `401ef5be2`, `0e9d76d89`, `268315309`, `8356e9205`, `c05255a83`, `7c3b79b72`, `fb796bf8c`, `1ccdaf7de`, `889c5ffb7`, `1b3f2735e`, `237c23a93`, `beeea74ab` | V9/V10 kernel hardening: event-state machine, preflight, signing, token factory, implementation safety, knowledge graph, implementer agent, public API, envelope dispatch, pressure sources, auto-merge guard, skill-genesis trigger, cost attribution, tests. | Valuable, but main now has a stronger enterprise autonomy line. Use as parity evidence for current kernel tests. |
| `SSOT-GAP-CANDIDATE` | `dc3c7fec9`, `dc459ff64`, `ec29e397a`, `4d9484c91`, `7bb3288c9`, `67ba81a59`, `d9e479d13`, `11b6384dc`, `f0a4b5968`, `0e5c781cc`, `02397c470`, `b338ff97a`, `f3a2ecc8c`, `95764dbda`, `a6aea519e`, `b69701b79`, `a10220179`, `e736eb6d6`, `c4e4dfac6` | Codex runtime hardening: cycle phase extraction, read-only preconditions, KG lock, text safety, signing lifecycle, profile/preflight/budget SSoT, plan source mining, implementation runner, cost telemetry, dry-run adapter forcing, convergence instrumentation. | Highest-value import lane. Review against current-main owners first, then integrate missing behavior only under fail-closed runtime defaults and update the owning invariant. |
| `SSOT-GAP-CANDIDATE` | `8113184ec`, `0807323b3`, `a64e34024`, `a068068ce`, `444cc63e4`, `719243ee8`, `1a56c9133`, `9d8f0dd85`, `0e88aa9b5`, `7bcc74da4`, `dc725992c`, `c4fed890a`, `b6f2f7d2d`, `c70071d6b`, `67528fbcf`, `46604aacb` | V10.4/V10.5 cross-review envelope fixes, planner dispatch metadata, revision bridge fixes, external outage state, watchdog, max-rounds propagation, poll-state ordering, terminal-state reading, implementation runner wiring. | Strong candidate lane for current-main invariant tests. Do not import associated finding files unless the current finding registry needs them. |
| `KEEP-MAIN` | `33a64da5f` | Aggregate Codex runtime capture: agent surface, artifact safety, state manifest, Codex runtime contract, current-state docs. | This is the most relevant snowball snapshot, but current main already carries a later authority line. Importing it directly would overwrite newer contracts. |
| `NO-IMPORT-MERGE` | `e1a1e30c1` | Broad merge of origin/main into snowball plus unrelated application, infra, migration, docs, and UI changes. | Merge commit is not a curated ARIA gain. It must not be replayed. |

## Next PR Slices

1. `codex/aria-snowball-runtime-owners`: prove or reject gaps in the current runtime owner modules:
   `runtime_profile.py`, `preflight.py`, `implementation_safety.py`, `gh_token_factory.py`,
   `budget.py`, and dry-run adapter behavior. Accepted changes must land in those owners and clean
   any conflicting legacy path.
2. `codex/aria-snowball-executor-owner`: prove or reject gaps in the current executor owner surface:
   `tools/aria-poc/ci_executor.py`, `worker_executor.py`, and `codex_runtime.py`. Accepted changes
   must keep one executor contract, one dry-run default, and one tested failure path.
3. `codex/aria-snowball-convergence-owner`: prove or reject gaps in the current convergence owner
   modules: `plan_convergence.py`, `plan_convergence_bridge.py`, `convergence_drainer.py`, and
   agent envelope contracts. Accepted changes must update owner tests and remove conflicting
   snowball-era schema/prose authority.

Acceptance for every slice: no generated runtime state, no stale finding churn, no direct branch
merge, no live autonomy enablement, one owner per behavior, and a duplicate/legacy cleanup outcome
recorded in the PR.
