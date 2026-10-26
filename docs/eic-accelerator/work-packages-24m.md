# ARIA: 24-month work-package plan (component TRLs 2-5 today, targets 6-8), draft for the EIC Accelerator short application

Prepared 2026-10-26 by the work-package planner. DRAFT for operator review; not yet reviewed by the company. Read-only on repositories and
ARIA state; no costs, headcount, customers or letters of intent are stated or implied anywhere in this file (section 8 lists what the
company must supply).

## 0. How to read this file

**Strength labels** (one per statement): `PROVEN` (verifiable now from a pinned source), `PARTIAL` (n small or one instance),
`BUILT_NOT_MEASURED` (built and tested, not yet measured), `NOT_YET` (not done; written in future tense with a month and a measurable
criterion), `FORBIDDEN` (we must never claim it; section 9).

**Attribution:** `(a)` = produced by ARIA's own runtime; `(b)` = engineering by Claude sessions and engineers; `(c)` = bookkeeping automation.
No statement in this file presents (b) or (c) as ARIA's own. Every capability merged since 2026-10-15 is (b) (EI[58]-EI[63]).

**Criterion source tag:** `S` = already scheduled in the internal plan (pointer given); `S*` = scheduled, but the number is only in plan text and
not yet registered in `genesis_policy` (EI[124]); `N` = NEW, proposed for this application, not in the internal plan, needs the company's
decision and pre-registration before its first measurement.

**Pointer keys** (all paths under `/root/aria-handover/2026-10-21/` unless stated):

| key                                    | source                                                                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EI[n]`                                | `/var/aqua-kampanya-ciktilari/aria-eic-2026-10/evidence-inventory-2026-10-25.json`, `rows[n]` (0-based; 127 rows; the `.md` appendix carries the same rows by claim id). `EI§n` = section n of the `.md` |
| `INV:<id>`                             | `INVENTORY-2026-10-26.md`, row id (pin: origin/main `61d594f02`; 175 rows); `INV:<n>` with a number = line                                                                                               |
| `PLAN:<line>`                          | `PLAN-v2.md` line                                                                                                                                                                                        |
| `ZOO:<line>`, `ARM:<line>`             | `zoo/ZOO-REPORT.md`, `zoo/arms/ARM-REPORT.md`                                                                                                                                                            |
| `PREREG:Am<n>`                         | `decision-test/PREREG.md`, amendment n (the original text is `PREREG:0`)                                                                                                                                 |
| `SEQ`, `DETP`, `PROG:<line>`, `OPTODO` | `build/SEQUENCE.md`, `build/DET-PLAN.md`, `PROGRESS.md`, `OKAN-TODO.md`                                                                                                                                  |
| `REPO:<path>`                          | `/var/aqua-saas/.worktrees/land-check` at `61d594f02` (origin/main, 2026-10-26T10:27+01:00)                                                                                                              |
| `MEM:<file>`                           | `/root/.claude/projects/-var-aqua-saas/memory/<file>` (operator decisions; team discussion, not repository evidence)                                                                                     |

Not read (sealed): `decision-test/cases.jsonl`, `SPLIT.md` and any SPLIT\*, held-out files, `zoo2/`. Counts of the sealed set are quoted only where
`PREREG` or `EI` already state them.

## 1. Baseline in twelve statements (what the plan starts from)

| #   | statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | label                                 | attr. | pointer                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----- | --------------------------------------------------------------------------------- |
| B1  | ARIA's runtime has been paused since 2026-10-16T14:41Z. There have been 0 cycles, 0 `aria/state` publishes and 0 `aria-implementer` commits since; seven runtime workflows are `disabled_manually`. That the pause is an operator decision rests on an internal note (MEM), not on repository evidence                                                                                                                                                                                                                      | PROVEN                                | a     | EI§0, EI[26], EI[37], EI[62], EI[123]; MEM:MEMORY.md "ARIA DURDURULDU 2026-10-16" |
| B2  | One converged plan became a CI-green product pull request (#1906, `LeavesPage.tsx` + spec) that a human merged, with human rescue acts; n = 1. The task came from operator requests                                                                                                                                                                                                                                                                                                                                         | PARTIAL                               | a     | EI[29], EI[30], EI[31]                                                            |
| B3  | ARIA merged 0 changes on its own: 0 of 352 auto-merge decisions were eligible; 0 backend (`apps/`) changes (a proven negative count; autonomous merging itself is NOT_YET)                                                                                                                                                                                                                                                                                                                                                  | PROVEN                                | a     | EI[35], EI[36], EI[116], EI[117]                                                  |
| B4  | Every committed finding cites code that exists as cited (110/110 refs, 22 findings); 71 ledger files / 63,331 rows have 0 broken hash chains; 59 of 833 agent results were rejected under the evidence law                                                                                                                                                                                                                                                                                                                  | PROVEN (admission and integrity only) | a     | EI[5], EI[21], EI[15], EI[53]                                                     |
| B5  | Discovery recall on planted real defects was 0 of 13 in the 2026-10-20 section test (exact 95% CI [0, 24.7%]; a contaminated practice score, 4 of the 13 reverts alter the detector or scorer; recorded, not reproduced); the report states only 4 of 17 adapters had scope on ARIA's own surfaces (not re-derived)                                                                                                                                                                                                         | PARTIAL                               | b     | EI[89], EI[91], EI[92]                                                            |
| B6  | Synthetic zoo, one run: ARIA's rule path found 3/36 injected defects (Wilson 95% [3%, 22%]) vs 35/36 for a plain LLM reading each diff; 0/12 false alarms for both. The defects were written by an LLM; this is a pilot, not a recall estimate                                                                                                                                                                                                                                                                              | PARTIAL                               | b     | ZOO:12-20, ZOO:38-41                                                              |
| B7  | ARIA's own role prompts run as agents on labelled items (n = 30 evidence-judge items; n = 14 change-intelligence diffs; n = 8 planner items; n = 10 injection items; one run; effort `high`, not the production `max`): the judge confirmed 15/15 true and refuted 8/8 false claims; change-intelligence named the labelled defect on 11/12 but its real output contract has no defect field; 0/10 injection notes were followed (only 4 of the 10 were informative). The adversarial judge was not run (model unavailable) | PARTIAL                               | b     | ARM:9-16                                                                          |
| B8  | 0 judges are calibrated (133 rows, max 1 sample per judge); 0 of 35 genesis requests produced a draft; the effect of memory on outcomes has n = 0; the old gain comparator would have said "improved" on 36.4% of A/A comparisons (analytical, p = 0.7, 5 runs per window) (proven negative counts; calibration, genesis and memory effect are NOT_YET)                                                                                                                                                                     | PROVEN                                | a     | EI[100], EI[107], EI[106], EI[108]                                                |
| B9  | Since 2026-10-15, 133 PRs merged to `main`; 19 capabilities are merged and test-pinned; 0 of 74 cycle heads contain any of them, so none has been exercised by ARIA's runtime                                                                                                                                                                                                                                                                                                                                               | BUILT_NOT_MEASURED                    | b     | EI§4, EI[58]-EI[63]                                                               |
| B10 | Internal program status at 2026-10-26: of 175 inventory rows, 34 are on `main`, 12 rows have an open PR (9 distinct PRs), 9 are built but unpushed, 7 are running, 100 are not started. Examination Board: only two parts exist, B1 (derived authority set, merged, built and tested, not yet measured) and B0 (an open PR, #2093, DIRTY, that needs the operator's enrolment signature)                                                                                                                                    | PROVEN (as status)                    | b     | INV:269, INV:B0, OPTODO #1                                                        |
| B11 | An ARIA MCP server exists for ARIA's own store: stdio JSON-RPC, 12 read tools and 2 write tools that need an operator-signed one-time approval (410 lines, first added 2026-09-03). It is an operator interface, not a customer product. ARIA has never run on a repository the company does not own                                                                                                                                                                                                                        | PROVEN (code); NOT_YET (external use) | b     | REPO:aria-kernel/aria_kernel/mcp_server.py; `git log --diff-filter=A` = 8920f913f |
| B12 | Productization (ARIA outside our repository; code and legal as separate products; customer brings own API key; MCP as a possible delivery form; no IDE direction on 2026-10-03) was discussed on 2026-10-03 and 2026-10-13. The notes record "decision not yet made". No code exists for it                                                                                                                                                                                                                                 | NOT_YET                               | -     | MEM:project_aria_direction_2026_10_03.md                                          |

Two more facts shape the plan. (1) The internal plan sized the code work in days (PLAN:8, PLAN:415-427); its day-numbers have already
slipped (G0 was due "day 2 evening", PLAN:421; F1.5 and F1.6 are NOT_STARTED, INV:F1.5, INV:F1.6). The 24-month plan is therefore sized by
event counts (cycles, cases, pilot sites) and operator acts, which is how the internal plan defines its own gates (PLAN:427, PLAN:412).
(2) The kernel carries aqua-specific content: about 20 of 414 top-level kernel modules (19 with the pattern `farm-service|aquaculture`, 30 with a list of seven service names; the count depends on the pattern) mention service names such
as `farm-service` or `aquaculture` (text grep, file count only; not a separability measurement; REPO:aria-kernel/aria_kernel).

## 2. Planning basis and assumptions

1. **Month numbering.** M1 = the first month of the Grant Agreement. The calendar mapping is the company's. From the call text pasted into this
   task: short-proposal feedback in about 4-6 weeks; full proposals batched on fixed dates; results about 8-9 weeks after batching; jury
   interview results 2-3 weeks after interview week; due diligence 2-6 months for any investment component. Nothing in this file assumes a
   start date; work done before M1 is baseline, not funded scope.
2. **Starting TRL is not 6 for any part.** The brief asks for TRL 6 to 8. The evidence supports TRL 5 at most (the TRL file's reading) for the
   evidence-admission and ledger-integrity layer (operated in one real environment, our own repository, about ten weeks: EI[5], EI[15], EI[21]); TRL 6 is
   arguable there and is not claimed. The planner's own
   assessment per component (not evidence; the company must confirm or change it, section 8):

   | component                                             | TRL now (assessment)                                   | basis                                                                       | TRL at M24 target        |
   | ----------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------ |
   | evidence admission, ledgers, hash chains              | 5 (the TRL file's reading; 6 is arguable, not claimed) | B4; one environment only; no tamper drill; quote law never applied live     | 7 (8 only through WP7)   |
   | plan -> PR change loop                                | 5                                                      | B2, B3: n = 1, human-merged                                                 | 7                        |
   | discovery of defects                                  | 4                                                      | B5, B6: 0/13 real, 3/36 synthetic                                           | 6 (own repo), 7 (pilots) |
   | memory and learning loop                              | 4                                                      | B8: injection proven, effect n = 0                                          | 6                        |
   | Examination Board and governed self-improvement       | 2 (Board), 3 (self-improvement elements)               | B10: B1 merged, B0 an open PR, B2-B7 no code; 0 self-made changes (EI[109]) | 6                        |
   | portable core, MCP / IDE surface, external deployment | 3                                                      | B11, B12                                                                    | 7-8                      |

   The application should present this component table, or a single TRL with the lowest component named; a blanket "TRL 6" would contradict
   B3, B5 and B8. This is an open question for the operator.

3. **One-sided vs two-sided bounds.** The internal plan's Wilson bounds are not on a single z. Recomputed by the planner: `0.65` for 24/30 matches
   z = 1.645 (0.657; at z = 1.96 it is 0.627); `0.38` for 30/60 matches z = 1.96 (0.377, which is just below 0.38, so 31/60 is needed there);
   "upper <= 10% (about 0/30)" holds only at z = 1.645 (0.083; at 1.96 it is 0.114). WP1 therefore includes the task of fixing one z in
   `genesis_policy` before any gate is evaluated. All implied minimum counts below state which z they use.
4. **Operator acts are on the critical path.** The Board enrolment signature, the runner Claude token, `vars.ARIA_STOP`, the funnel
   activation, continuous-cycle permission and the merge authority are operator-only acts (PLAN:466-485, INV:316-336). The plan carries them
   as dependencies, not as things ARIA can do.
5. **Shared provider quota.** ARIA's runner and the engineering sessions share one account's weekly Claude quota (MEM:MEMORY.md "Paylaşılan haftalık Claude kotası"); a quota stop pauses the plan without losing work (MEM:MEMORY.md "Kota yenilenince kaldığı yerden devam"). Costs of this are for the company to
   state (section 8).

## 3. Overview

| WP  | title                                                       | months                    | TRL in -> out         | depends on          | share of criteria already scheduled |
| --- | ----------------------------------------------------------- | ------------------------- | --------------------- | ------------------- | ----------------------------------- |
| WP1 | Measured restart and measurement spine                      | M1-M6 (monitoring to M24) | 5 -> 6 (runtime loop) | operator acts       | mostly S                            |
| WP2 | Discovery: change-review path, detectors, decision test     | M2-M14                    | 4 -> 6                | WP1 (G0)            | mostly S, plus N                    |
| WP3 | Verified change: red-first, outcome truth, merge lane       | M3-M14                    | 5 -> 7                | WP1, WP2 (D6/D7)    | mostly S, plus N                    |
| WP4 | Evidence-bound memory and learning loop                     | M4-M16                    | 4 -> 6                | WP1, WP3 (outcomes) | mostly S, plus N                    |
| WP5 | Independent Examination Board and governed self-improvement | M3-M18                    | 2 -> 6                | WP1, WP3            | S; N for external audit             |
| WP6 | Portable core, MCP / IDE surface                            | M6-M20                    | 3 -> 7                | WP2, WP3            | all N                               |
| WP7 | Pilot deployments in operational environments               | M12-M22                   | 6 -> 8                | WP2, WP3, WP6       | all N                               |
| WP8 | Independent validation, final proof, compliance, management | M1-M24 (peak M16-M24)     | 7 -> 8                | all                 | S for stage 3; N for the rest       |

Critical path (event counts, not calendar): G0 (M2) -> G1 (M5) -> D3/D9 and DEV checks (M6-M8) -> freeze SHA and D-FINAL (M10-M12) ->
stage-2 (M12-M14) -> G3 with 7 Board-shadow cycles (M14-M16) -> first gated self-promotion (M16-M18, only if every gate holds) -> stage-3
(M18-M22). Pilots (WP7) start once WP6 has a first external install (M12). Every date here is a plan, not a result.

---

## 4. Work packages

Each package lists: objective, baseline, deliverables, acceptance criteria (with statistical form), months, dependencies, risks and the
fallback if a criterion is missed, and the TRL it brings. Criteria use the internal plan's own form: rates are reported with n and a
Wilson bound, and a gate looks at the lower bound, not the point estimate (PLAN:40).

### WP1. Measured restart and measurement spine (M1-M6; continuous monitoring to M24)

**Objective.** Restart ARIA's runtime under observation, and make every number it or we report reproducible, stamped and statistically sound.
Nothing in WP2-WP8 can be claimed as an ARIA result without this.

**Baseline.** B1 (paused). One learning ledger is not yet one: two writers still append directly (INV:F1.1, NOT_YET at inventory time; a package
for it was built on 2026-10-26 and its push was pending, PROG:335). The scorecard and its G1 field list do not exist (INV:F1.2). The offline baseline exam with a
triple stamp does not exist; the numbers in use (zoo 3/36, ARM) are unstamped (INV:F1.3). The paired gain test (exact McNemar, Wilson lower,
A/A floor) is merged (PR #2103, INV:F1.7; BUILT_NOT_MEASURED, 0 real paired runs: EI[70], EI[108]). The state restore drill is green (INV:F1.4).
Disk was 27 GB free on 2026-10-26 against a 35 GB working floor (INV:F0.0; measured 2026-10-26). All 29,056 governance rows record `actor.kind = human`, so ARIA acts and
operator acts cannot be separated by that field (EI[122]).

**Deliverables.**

1. D1.1 One learning ledger (F1.1), scorecard with 3 lens specs and the G1 field list (F1.2), offline baseline exam with triple stamp and
   re-baseline of the 29/614 noise counts on a fixed SHA (F1.3). `S` (PLAN:180-187).
2. D1.2 Controlled observe-only loop opened by the operator (F1.5), then G0 and G1 cycles (F1.6). `S` (PLAN:189-192).
3. D1.3 Statistical methods in their owners: anytime-valid sequential decision, hierarchical partial pooling, CUSUM drift detection with
   change-point attribution to merges, online FDR (F1.8). `S` (PLAN:198-223).
4. D1.4 All gate thresholds registered as numbers in `genesis_policy`, with one stated z (today they exist only in plan text: EI[124]). `S*` (PLAN:40).
5. D1.5 Production feed and watchdog host installs (RW-1, RW-2), after the operator decides to enable ARIA (INV:RW-1, INV:RW-2).
6. D1.6 Provenance field that separates ARIA-runtime acts from operator acts in governance rows. `N`.

**Acceptance criteria.**

| ID   | criterion                                                                                                                                                              | statistical form                                                                                                            | tag / pointer                    | by  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --- |
| A1.1 | G0: at least 3 consecutive clean measured cycles in observe-only mode                                                                                                  | n = 3; a runtime-works check, not an estimate                                                                               | S: PLAN:192, PLAN:405            | M2  |
| A1.2 | G1: 14 consecutive cycles in which every field in the F1.2 list is measured (not None). A gap = missing report, `state_integrity_gap`, or a field falling back to None | n = 14; any gap restarts the count                                                                                          | S: PLAN:406                      | M5  |
| A1.3 | Every number in any report carries the triple stamp (ARIA SHA, corpus hash, provider/model)                                                                            | 100% of numbers in the M6 measurement report                                                                                | S: PLAN:186, PLAN:509            | M6  |
| A1.4 | Fixtures for each F1.8 method (A/A, known drift, known true effect). Peeking each cycle: false "improved" rate on A/A <= alpha (today 36.4%, EI[108])                  | n_AA >= 200 trials proposed (the plan states no n; the PR-body figure 48/100 was not reproduced, EI§6); report Wilson upper | S: PLAN:197, PLAN:207; n_AA is N | M4  |
| A1.5 | New consensus HUMAN_REQUIRED = 0, and the unverifiable share <= baseline + a pre-registered margin                                                                     | counts per G1 cycle, n = 14 cycles                                                                                          | S: PLAN:133                      | M5  |
| A1.6 | Stale-refusal share of agent requests <= 20% over the G1 cycles (baseline 59.7%; 833/2,313 answered, EI[118])                                                          | n = requests in 14 cycles; report Wilson upper; 20% is a proposal                                                           | N                                | M5  |
| A1.7 | Open HUMAN_REQUIRED count at the end of G1 <= its count at the start (baseline 502 open, 469 breaching SLA on 2026-10-16: EI[119])                                     | counts; no growth                                                                                                           | N                                | M5  |
| A1.8 | Provenance: 100% of new governance rows distinguish ARIA-runtime acts from operator acts                                                                               | n = rows written in G1                                                                                                      | N (baseline EI[122])             | M3  |

**Dependencies.** Operator acts: Board enrolment signature (B0, OPTODO #1), `vars.ARIA_STOP` (PLAN:482), runner Claude token (OPTODO #2),
runtime-profile ceiling change `strict` -> `standard` (INV:334), readiness-claim workflow disabled (INV:F1.5). The 2026-10-24 approval names only
WP-J and B0 as gates while PLAN:190 also requires F1.1 and F1.2 (INV:311, contradiction 8): to be reconciled in M1.

**Risks and what we do if a criterion is missed.**

- G1 cannot reach 14 consecutive clean cycles (runtime gaps, provider outage, disk below the floor, quota). We restart the count, report each gap
  by name, and extend WP1 by up to 2 months drawn from WP8 slack; if G1 is still unmet at M8, WP2-WP5 continue on offline harness measurements
  (the acceptance harness and decision test run outside ARIA: EI[9]) and every runtime claim stays NOT_YET in the application.
- The 59.7% stale-refusal share is the whole-history figure; the October 1-16 share was 28.2% and the share answered 60.5% (EI[118]), so whether the
  stale share is structural is not established. If A1.6 fails, the cause is found in the G1 cycles (a cycle-cadence change in the kernel is one
  candidate, not a finding), and the honest statement stays "36% answered over the whole history" until it holds.
- Operator-act bottleneck and concentration (667 of 720 non-merge commits since 2026-10-15 are under one shared git identity, EI[60]; how many
  people use it is not in the repository). Mitigation is a second authorised operator (company fact, section 8); without it, WP1 start-up delay is unbounded.

**TRL.** Runtime loop 5 -> 6 (relevant environment = our repository, in continuous measured operation).

### WP2. Discovery: change-review path, detector program, decision test (M2-M14)

**Objective.** Make ARIA find real regressions at a rate that is measured against a real-defect set and against plain Claude and an agent group,
without more noise. Today it finds none of 13 real ones.

**Baseline.** B5, B6, B7. The internal diagnosis (PLAN:11-22, ZOO:24-31): no adapter models behaviour (0 of 12 logic defects found); rule scope
is narrow; the finding layer, not the judges, is the gap (ZOO:36-37). The planned fix is an LLM reviewing ONE change with the rules as a cheap
pre-filter (ZOO:36-37). Built: change-review entry D1 (#2094) and context D2 (#2110), per-change budget D4 (#2122), one red-first prover D5
(#2102), one diversity function F0.8 (#2095), one acceptance bar F2.3 (#2104; 39 tests green, never exercised: EI[24]); all `BUILT_NOT_MEASURED`
(INV:D1, D2, D4, D5, F0.8, F2.3). D3 (discovery to hypotheses) was running on 2026-10-26 (INV:D3). Not on `main`: D6, D9 (built, unpushed), D7,
D8, D10, D12, SE-5..SE-12, F2.2, F2.5, F2.6, F5.2, F5.4, F5.7 (INV rows); F2.4 is UNKNOWN in the status inventory (its quote-law mechanism is on main via #2073 and ships off; the exit percentage is unmeasured). The detector program has 48 package rows: 3 on `main`, 6 open PRs,
5 running, 34 not started (INV:DET row, INV:269; sequencing in DETP). The decision test (A vs B vs C) has run 0 of 35 real cases and 0 of 120 clean
controls (EI[125]). The 13 public rollbacks are used only as a practice score, never as a gate (PLAN:464, PLAN:277).

**Deliverables.**

1. D2.1 Discovery to hypotheses (D3), seat pin to kernel proof (D6), one promotion bar (D7), adapter channel per change (D8), discovery-recall
   block and DEV miss feed (D9/F5.2), test-writer methods differential / changed-line mutation / invariant mining (D12/F5.6b), service-expertise
   routing and hand-off (SE-5..SE-9). `S` (SEQ waves C-I, PLAN:273-321).
2. D2.2 Input contract and live quote law (F2.4), finding identity v2 (F2.5), population selector (F2.6), noise classes as negative fixtures (F2.2). `S` (PLAN:225-234).
3. D2.3 Real module mutants and hard negatives built by the single mutant builder, real-provider judge, SZZ replay on the Board side
   (F5.4, F5.7). `S` (PLAN:280-318).
4. D2.4 Detector packages from the root-cause reports (sql, tenant, typeorm, testgap, contracts, scope, lint, crossfile). `S` (DETP).
5. D2.5 Decision test: DEV checks within the 6-look budget, freeze SHA, one HELD-OUT run with arms A1 (learned), A2 (empty store),
   A3 (no service packs), B, C. `S` (PREREG:Am2, Am3, Am4).
6. D2.6 Rerun of the synthetic zoo and the part-by-part behaviour test on the frozen SHA, reported with Wilson bounds, never as a gate. `N`.

**Acceptance criteria.**

| ID    | criterion                                                                                                                                                      | statistical form                                                                                                                                                                                                                                                                              | tag / pointer               | by  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --- |
| A2.1  | Stage-2 discovery recall: point >= 50%, n >= 60 real defects, Wilson lower >= 0.38, stratified by source (claude / zcode / aria / other)                       | 31/60 passes at z = 1.96 (lower 0.393), 30/60 passes at z = 1.645 (0.396); baseline 0/13                                                                                                                                                                                                      | S\*: PLAN:409, PLAN:316-318 | M14 |
| A2.2  | False alarms: reports per clean commit of A1 <= B and <= C                                                                                                     | n = 120 clean controls; counts with Wilson                                                                                                                                                                                                                                                    | S: PREREG:Am1, Am2          | M12 |
| A2.3  | Decision test: A1 beats B and A1 beats C in recall, each by one-sided exact McNemar p < 0.05, held-out set sealed, one run                                     | n_paired = 35 real regressions (11 uncontaminated, 24 contaminated) plus fresh post-freeze regressions appended; with 35 cases p < 0.05 needs roughly 9 of 10 discordant pairs in A1's favour (exact: 9/10 gives 0.011, 8/10 gives 0.055); an inconclusive result is reported as inconclusive | S: PREREG:Am1, Am3          | M12 |
| A2.4  | Service knowledge is kept only if P(theta > 0.5) >= 0.95 on held-out A1 vs A3 and reports per clean commit A1 <= A3                                            | posterior `beta_posterior(1+b, 1+c)`; 6 DEV-check looks in total                                                                                                                                                                                                                              | S: PREREG:Am4               | M12 |
| A2.5  | Quote law: >= 95% of sampled examples quoted; observable coverage >= 90% (baseline 0 of 2,364: EI[97])                                                         | n = sample size fixed at registration; Wilson lower reported                                                                                                                                                                                                                                  | S: PLAN:232                 | M8  |
| A2.6  | Promotion bar: new non-anchor promotions = 0; 100% of new promotions verified at the SHA (today 5 of 13 promotions are anchor-grade: EI[96], EI[67])           | counts over all promotions after restart                                                                                                                                                                                                                                                      | S: PLAN:231                 | M8  |
| A2.7  | Judge two-bar law per module class: both bars >= 0.9 at the Wilson lower bound, >= 60 items per class; unverifiable and tier-0 refusals count as "not correct" | n >= 60 per class; at z = 1.645 this needs >= 58/60 (lower 0.904), at z = 1.96 >= 59/60 (0.911); the "or openly registered" exit is removed                                                                                                                                                   | S: PLAN:286                 | M10 |
| A2.8  | Each of the 3 test-writer methods proves at least one real finding with a red test or is recorded as "none found"; a method with 0 contribution is closed      | counts per method; cost per method on the scorecard                                                                                                                                                                                                                                           | S: PLAN:309-312             | M12 |
| A2.9  | Every new detector finding on clean `main` is a verified true positive or a named false positive; each detector package ships near-miss negatives              | counts per package                                                                                                                                                                                                                                                                            | S: PLAN:229, DETP           | M12 |
| A2.10 | Clean-control cost per case (tokens, wall time) is reported for every arm                                                                                      | all arms                                                                                                                                                                                                                                                                                      | S: PREREG:Am2               | M12 |

**Dependencies.** WP1 for runtime measurement; registry cutover MF-2 (#2120) before D6, D9, F3.3a and REG-ID can be pushed (INV:276-277); the
runner Claude token for the decision-test arms (INV:D-FINAL); D-COMP (sandbox repo and commercial-reviewer arm) before D-FINAL (SEQ,
2026-10-23); D9 must-fix: `dev_split` does not canonicalise the sha (103 of 399 shas flip, INV:D9).

**Risks and what we do if a criterion is missed.**

- A2.3 is the plan's central risk. A one-run, 35-case test has little power (PREREG:Am3 says so). If A1 does not beat B and C, we publish the
  result as it is, drop any "ARIA finds more than plain Claude" claim, and move the funds of D2.1 items not yet built to WP3, WP4 and WP6, where
  the claim is verification, memory and integration, not discovery. The ZOO pilot already shows a plain LLM is strong on diffs (35/36, ZOO:14).
- The held-out set is mostly contaminated by our own history (24 of 35, PREREG:Am3). A2.1 needs n >= 60; the shortfall is covered by fresh
  post-freeze regressions (PREREG:Am3), by SZZ replay over more history (F5.7) and, only after M12, by pilot repositories (A7.3).
- Single-provider correlated blind spot (PLAN:489-494). Mitigation: method diversity, fresh-clone blind witness, reality partition, and a second
  provider for every new seat (PLAN:97).
- LLM-written defects are easier than real regressions (ZOO:38-41); no result from the zoo is used as a gate.

**TRL.** Discovery 4 -> 6 on our repository (tested against real regressions in a relevant environment). 7 is claimed only through WP7.

### WP3. Verified change: red-first, outcome truth, merge lane (M3-M14)

**Objective.** Every change ARIA makes carries a test that is red at base and green at head for the right reason; the question "did the change
hold?" has one answer; ARIA earns merge authority from measured behaviour.

**Baseline.** B2, B3. 0 red-first proofs in live state, ARIA-HIGH-671 open (EI[101]); "did the change hold?" has 4 code paths and 1 outcome row,
verdict `unknown` (EI[102]). The prover D5 is merged but has no production caller (INV:F3.2); merge index and self-revert coverage (F3.3a, F3.4)
are built but unpushed (INV:F3.3a, F3.4); F3.3b, F3.5, F3.6, F3.7, F3.8, F3.10 are not started (INV). The kernel change lane (F0.4c) is built
but absent from `main` although B1 and B4 presuppose it (INV:F0.4c, INV:304).

**Deliverables.**

1. D3.1 Apply gate with red-first and reproduction witness, `fix_verified` closure (F3.5); red-first step inside the existing required
   `aria-kernel` check (F3.6). `S` (PLAN:250-254).
2. D3.2 `change_outcome` core: `reverted`, `post_merge_ci` by nearest ancestor, `closure_by_any_author`, reality / Board partition invariant;
   merge index in `merge_record`; self-revert for every ARIA merge (F3.3, F3.4). `S` (PLAN:242-249).
3. D3.3 Auto-merge snapshot: one diff source, replay of the 25 historical PR fixtures (F3.7). `S` (PLAN:255).
4. D3.4 Plan contract v3 (concept + existing-owner field), impact miss rate, decision questioning to arbiter (F3.8-F3.10). `S` (PLAN:256).
5. D3.5 Actionable precision over all promoted findings (F4.2). `S` (PLAN:262-266).
6. D3.6 Operator grants implement-and-merge authority for ARIA after F3.7 (operator decision A7; PLAN:255, PLAN:475). Not ours to schedule.

**Acceptance criteria.**

| ID   | criterion                                                                                                                                                                                                                                                                    | statistical form                                                                                                                                                            | tag / pointer   | by  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --- |
| A3.1 | Red-first CI step: false-trip rate Wilson upper <= 10%; mandatory by a fixed date, else it stays open with a tracked finding                                                                                                                                                 | 0/30 gives 0.083 at z = 1.645; at z = 1.96 the same 0/30 gives 0.114 and fails, so z must be fixed (WP1 D1.4)                                                               | S: PLAN:253-254 | M10 |
| A3.2 | Auto-merge replay over the 25 PR fixtures: one decision per `head_sha`; structural block < 10%                                                                                                                                                                               | n = 25; only 0/25 gives an upper bound below 10% (0.098 at z = 1.645); 1/25 gives 0.161; the plan's "< 10%" is a point rule on n = 25 and is reported with its Wilson upper | S: PLAN:255     | M8  |
| A3.3 | Outcome truth: every decision attributable with a named reason; false-regression rate on the 98 non-ARIA merges reported                                                                                                                                                     | n = 98; Wilson reported                                                                                                                                                     | S: PLAN:248     | M8  |
| A3.4 | Actionable precision: point >= 80%, n >= 30, Wilson lower >= 0.65                                                                                                                                                                                                            | 24/30 gives 0.657 at z = 1.645, 0.627 at z = 1.96; baseline: n = 0 human or outcome labels (EI[99])                                                                         | S\*: PLAN:409   | M12 |
| A3.5 | Finding identity v2: suppression-parity replay 100% on `aria/state` `8e39b2eeb`                                                                                                                                                                                              | n = rows replayed; 100%                                                                                                                                                     | S: PLAN:233     | M8  |
| A3.6 | Corrected population: precision Wilson lower >= `precision_min` with n >= `min_samples`                                                                                                                                                                                      | values registered in WP1                                                                                                                                                    | S: PLAN:234     | M10 |
| A3.7 | Rescue-free merges: of the first >= 30 ARIA-authored changes merged by the operator-granted merge lane, share merged with no human rescue (no manual update-branch, no manual kernel fix, no manual repair). Baseline: 1 ARIA product commit, 0 rescue-free merges (EI[117]) | point >= 80%, n >= 30, Wilson lower >= 0.65 (same form as A3.4)                                                                                                             | N               | M14 |
| A3.8 | At least 10 of those >= 30 changes touch `apps/` or `libs/` (baseline 0 `apps/` commits: EI[36])                                                                                                                                                                             | count; 10 is a proposal                                                                                                                                                     | N               | M14 |
| A3.9 | Revert / post-merge-CI-red rate attributed to ARIA merges, reported with n and Wilson upper; the threshold is pre-registered at M6, before measurement (no number is set now)                                                                                                | n = merges in the window                                                                                                                                                    | N               | M14 |

**Dependencies.** WP1; F0.4c (`kernel_change_lane`) lands first because `apply_engine.py` overlaps (INV:290); D6 overlaps `validation.py` and
`plan_contract.py` (INV:297); F3.3b waits for F3.3a (INV:296); MF-2 cutover. **Operator decision A7** (merge authority) is required before
A3.7 can start (PLAN:475).

**Risks and fallback.**

- A7 is not granted, or F3.7 shows a block rate above 10%: ARIA delivers red-first-proven pull requests that humans merge. The claim becomes
  "ARIA prepares verified changes", the TRL for the merge lane stays 5 and the application drops the word "autonomous" for merging.
- Throughput: 1 ARIA product PR in the whole history (EI[29]); 30 merged changes in M10-M14 may not be reached. If fewer than 30 are merged by M14,
  A3.7 is reported with the actual n and its Wilson lower bound, marked "not met", and stage-3 (A8.2) moves right by the same amount.
- Red-first false trips above the bound: the CI step stays advisory, tracked finding opened, the apply gate stays authoritative (PLAN:254).

**TRL.** Change loop 5 -> 7 for proposing verified changes in our repository; the merge lane is TRL 6 at best unless A3.7 is met.

### WP4. Evidence-bound memory and learning loop (M4-M16)

**Objective.** Show, by measurement, whether memory and lessons change outcomes; keep it safe against prompt injection and poisoned learning;
and produce the first genesis result (a skill or agent made by ARIA) or an honest "none".

**Baseline.** B4 (admission and integrity proven), B8. Memory injection reaches 1,588 of 2,313 requests, its effect has n = 0 (EI[106]); lessons
reach 0 of 2,313 envelopes as anti-patterns (EI[103]); conventions are 10 rows without claim text (EI[104]); belief contradictions never fired
(EI[105]). The trust boundary is merged only for the change-review slice (F4.0a, D2 #2110); the rest, the one remedy table, provenance and the
"no orphan memory" invariant are NOT_STARTED (INV:F4.0b, F4.7, F0.9p). Genesis: 0 drafts of 35 requests (EI[107]).

**Deliverables.**

1. D4.1 Trust boundary for lessons, conventions, mission headings, proposer prose and commit/PR text; injection fixtures (F4.0b). `S` (PLAN:260).
2. D4.2 Outcome-backed episodes with lesson-drop reasons (F4.1); convention identity (F4.4); uncertainty kinds (F4.5); lift-based restore and
   tombstone with a poisoned-learning canary (F4.6); one remedy table (F4.7). `S` (PLAN:261-271).
3. D4.3 Provenance layer and "no orphan memory" invariant (F0.9p). `S` (PLAN:169-176; INV:F0.9p NOT_STARTED).
4. D4.4 Genesis chain repair and one trigger path; retirement (SE-10..SE-12); kernel genesis router (F0.4b, built unpushed). `S` (INV).
5. D4.5 Memory-effect measurement: A1 (learned) vs A2 (empty) arms of the decision test. `S` (PREREG:Am2).

**Acceptance criteria.**

| ID   | criterion                                                                                                                                                                                                                      | statistical form                                                    | tag / pointer                                     | by  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------- | --- |
| A4.1 | Injection fixtures are processed as data; unlabelled mixed-provenance paths = 0                                                                                                                                                | 100% of the fixture set; the fixture count is fixed at registration | S: PLAN:260                                       | M8  |
| A4.2 | "No orphan memory": every lesson, convention and belief resolves to an evidence or outcome row                                                                                                                                 | 100% over the full ledger; n = rows                                 | S: PLAN:174                                       | M10 |
| A4.3 | The contradiction recorded in ARIA-MEDIUM-640 is resolved from state (PLAN:268 says "640 çelişkisi"; the contradiction ledger holds 0 rows today, EI[104])                                                                     | count                                                               | S: PLAN:268                                       | M10 |
| A4.4 | Lift-based restore applies only after 7 measured cycles; a poisoned-learning canary is rejected                                                                                                                                | canary n fixed at registration                                      | S: PLAN:270                                       | M12 |
| A4.5 | Memory effect: A1 vs A2 on held-out recall, secondary arm; DEV-check pack keep needs P(theta > 0.5) >= 0.90 and no rise in reports per clean commit                                                                            | posterior as PREREG:Am4                                             | S: PREREG:Am2, Am4                                | M12 |
| A4.6 | Of lessons admitted to the ledger, the share delivered to an agent envelope or carrying a named drop reason = 100% (baseline 0 of 2,313 envelopes carry anti-patterns: EI[103])                                                | n = lessons admitted                                                | N                                                 | M10 |
| A4.7 | Genesis: at least one skill or agent made by ARIA reaches ACTIVE under the registered rule (paired exact one-sided McNemar p < 0.05, no rise in clean-commit reports, k_min = 3). "At least one" is a plan, not an expectation | count; the result may be 0                                          | S for the rule (PREREG:Am4); N for the count >= 1 | M16 |

**Dependencies.** WP1 (G1 cycles generate episodes), WP3 (outcome rows), WP2 (DEV-check looks are shared and capped at 6 per frozen SHA,
PREREG:Am4).

**Risks and fallback.** If A4.5 shows no gain from memory, the application states "memory is existence-bound (cited code exists) and its ledgers are hash-chained; its effect
on outcomes is not demonstrated", and the learning-loop claim stays NOT_YET. If A4.7 yields 0, the application does not mention self-made
agents. A poisoned lesson found by the canary triggers rollback by tombstone (F4.6), never deletion (PLAN:461).

**TRL.** Memory and learning 4 -> 6.

### WP5. Independent Examination Board and governed self-improvement (M3-M18)

**Objective.** Build the approval root that is outside ARIA's trust domain, so ARIA's changes to itself can be tested on a sealed exam and
approved by a signed decision, with automatic rollback. Only then can "self-improving" become a measured claim.

**Baseline.** B10 and EI[109]: 7 self-change missions opened, 0 self-change proposals, the lane writes its own test and asks a human. Merged:
the derived authority set B1 (#2087, 97 tests, EI[78]) and the paired gain test F1.7 (#2103). B0 is an open PR, 51 commits, 241 behind `main`,
needs the operator's enrolment signature; the environment `aria-board` and the private vault repository exist (INV:B0; operator acts done: INV:326, INV:328).
B2-B7 are not started (INV). `vars.ARIA_STOP` does not exist (INV:329).

**Deliverables.**

1. D5.1 Board identity, vault cipher, job guard, `vars.ARIA_STOP` read by every workflow (B0). `S` (PLAN:323-331).
2. D5.2 Decision owner and exam runner with signed verdicts (B2); fresh-clone blind witness (B3); eight seams to one signed-verdict root (B4);
   end-to-end lane with rate cap (B5); in-room shadow, EVAL_WINDOW and revert drill (B6). `S` (PLAN:352-390).
3. D5.3 Landing of the kernel change lane (F0.4c) and the genesis router (F0.4b). `S` (PLAN:121).
4. D5.4 Seeded-proposal drill, G3, external audit (B7). `S` (PLAN:391-394).
5. D5.5 Independent penetration test of the Board's trust boundary by a third party. `N`.

**Acceptance criteria.**

| ID   | criterion                                                                                                                                      | statistical form                                                                                                            | tag / pointer                                                                                            | by  |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --- |
| A5.1 | B0 leak probe red -> green (the runner uid cannot read the vault); signature verification; ARIA_STOP fixture at merge time                     | pass/fail fixtures                                                                                                          | S: PLAN:331                                                                                              | M6  |
| A5.2 | B1 rail-weakening fixtures: 3 of 3 rejected on the realised diff                                                                               | n = 3                                                                                                                       | S: PLAN:351 (merged code, BUILT_NOT_MEASURED live: EI[78])                                               | M6  |
| A5.3 | B4: all 8 seams read one signed-verdict root and every approval kind is classified in the classification test                                  | 100% of kinds                                                                                                               | S: PLAN:364-381                                                                                          | M12 |
| A5.4 | G3: B7 drill 100% and >= 30 seeded proposals (known-bad and known-good by construction); agreement Wilson lower >= 0.85; 7 Board-shadow cycles | at z = 1.645 needs >= 29/30 (0.864); at z = 1.96 needs 30/30 (0.886); agreement measured only against the reality partition | S\*: PLAN:392-393, PLAN:410                                                                              | M16 |
| A5.5 | Bad-merge drill: automatic revert and `self_merge_freeze` fire                                                                                 | pass/fail, n drills fixed at registration                                                                                   | S: PLAN:389-390, PLAN:453                                                                                | M16 |
| A5.6 | First real self-promotion happens only when G1, G3, stage-2 and B4 all hold; each promotion passes the F1.7 paired test                        | count of promotions; may be 0                                                                                               | S: PLAN:411                                                                                              | M18 |
| A5.7 | External audit of the Board by a party independent of the company, report delivered                                                            | pass/fail                                                                                                                   | N (the plan says "WP-X external seat" and does not define whether that is a human third party: PLAN:394) | M16 |

**Dependencies.** WP1 (G1 is an input to promotion), WP3 (F3.2 prover pin, change_outcome reality partition), operator acts B0 signature,
Board provider token, `ARIA_STOP`, and decisions A2 (permanent human list), A3 (is unfreeze / revert-merge Board-adjudicable?) (PLAN:467-476, INV:316-324).
Decision A3 decides what may be said: if it is "no", two human steps remain after any rollback and the "no human in the loop" wording is
withdrawn for those steps (PLAN:375).

**Risks and fallback.**

- Agreement lower bound < 0.85 at G3: no self-promotion; ARIA remains human-gated; "self-improving" stays NOT_YET and is not used.
- The Board runs on a single provider family (PLAN:489). Mitigation: seat diversity by method, fresh clone, a second provider for Board seats (PLAN:97).
- Board enrolment is delayed by the operator signature (the single most urgent open act, INV:327): A5.1 then moves right with the whole chain.
- B4 is the riskiest change in the program (PLAN:498): full protocol, adversarial review, bad-merge drill before any real promotion.

**TRL.** Board 2 -> 6, governed self-improvement elements 3 -> 6 (validated in our own repository with sealed exam and drill).

### WP6. Portable core, MCP / IDE surface (M6-M20)

**Objective.** Make ARIA installable on a repository the company does not own, read-only first, and reachable from developers' tools through
MCP. This is productization discussed by the team (B12), not yet decided; this WP exists only if the company decides it, and the decision is an
open question.

**Baseline.** B11, B12. The kernel already has an MCP server, client, broker and relay (4 modules, 1,134 lines; REPO:aria-kernel/aria*kernel/mcp*\*.py),
a provider gateway and an egress relay. Coupling to this repository: about 20 of 414 kernel modules mention aqua-specific names (section 1; pattern-dependent). The
team's 2026-10-13 notes: one core plus domain packs (code, legal), per-customer installation of the same image, customer's own API key,
customer data never given to another customer, only a closed-schema lesson may be shared (a proposal that was not accepted); the legal vertical's
target is document folders, not git (MEM:project_aria_direction_2026_10_03.md). The legal vertical is outside the scope of this plan (open question).

**Deliverables.**

1. D6.1 Core / pack separation: aqua-specific content moves to a pack; a repository invariant fails if a core module depends on pack content. `N`.
2. D6.2 Foreign-repository onboarding: documented procedure, observe-only mode first, no writes to the customer repository; stack-independent
   review path (D1 change review) works without the aqua-specific adapters. `N`.
3. D6.3 Installable package per customer (same image per version), customer-held provider key, no customer content leaving the installation
   except to the customer's own provider. `N`.
4. D6.4 MCP surface for developers: read tools (status, findings query, review-this-change), write tools only with the existing signed-approval
   gate (ADR-0023 pattern, REPO:aria-kernel/aria_kernel/mcp_server.py); usable from IDE clients that speak MCP. A bespoke IDE plugin is not planned (the
   2026-10-03 note says there is no IDE direction). `N`.
5. D6.5 Per-customer lesson isolation: default is no cross-customer sharing; any sharing needs a closed schema, a minimum number of
   customers and a legal opinion (company supplies). `N`.

**Acceptance criteria** (all new, all `N`).

| ID   | criterion                                                                                                                                                                                                                                           | statistical form                                                                   | by  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --- |
| A6.1 | Separability invariant in CI: 0 core-to-pack dependencies (baseline: about 20 of 414 kernel modules mention aqua-specific names; pattern-dependent, section 1)                                                                                      | count = 0                                                                          | M10 |
| A6.2 | Cold-start install by a person who did not build ARIA, from the written procedure only, on 3 repositories the company did not author, each reaching one clean measured cycle in observe-only mode; time and number of manual interventions recorded | n = 3; counts only (3 sites give no meaningful Wilson bound, and the file says so) | M14 |
| A6.3 | Egress test: 0 bytes of customer repository content reach any destination other than the customer's own provider endpoint during a full cycle                                                                                                       | 100% of test cycles, n >= 10 cycles                                                | M14 |
| A6.4 | MCP: a contract test for every tool; 100% of write tools refuse without a valid signed one-time approval; a replay of a spent approval is refused                                                                                                   | counts over all tools                                                              | M12 |
| A6.5 | Third-party security assessment of the installable package and MCP surface, with no unresolved HIGH finding                                                                                                                                         | pass/fail                                                                          | M18 |

**Dependencies.** WP2 (stack-independent review path), WP3 (red-first gate for any write), WP5 (Board is optional per customer; its trust domain
is ours, not the customer's: to be designed). Company decisions on domain scope (code only?), licensing, hosting.

**Risks and fallback.** The aqua-specific adapters (NestJS / TypeORM / tenant rules) will not transfer to other stacks; the LLM-review path
and the evidence law are the portable part. If A6.2 fails on a repository, we publish the failure class and the application claims portability
only for the stack classes that passed. If the company decides not to productize, WP6 and WP7 are removed and the grant scope is WP1-WP5 and WP8
(TRL ceiling 7 in our own repository).

**TRL.** Portable core / integration 3 -> 7 (system prototype in an operational environment); 8 only through WP7.

### WP7. Pilot deployments in operational environments (M12-M22)

**Objective.** Show ARIA working on real repositories and teams outside the company, in stages that never write without review: observe-only,
then suggest-only (humans merge), then, per customer policy, a Board-gated merge lane.

**Baseline.** None. ARIA has never run outside our repository (B11). The repository contains no customer, no pilot site and no letter of intent.
Pilot sites are a company fact (section 8); this plan states no number of sites. The criteria below are per pilot repository set and pooled.

**Deliverables.**

1. D7.1 Pilot agreements, data-processing terms and per-site policy (observe / suggest / gated merge). Company supplies.
2. D7.2 Operation logs and a per-site report with the triple stamp (WP1) for every number.
3. D7.3 Recall replay on each pilot repository's own fix history (SZZ replay, F5.7 method on non-own code). `N`.
4. D7.4 Cost report per reviewed change. `N`.

**Acceptance criteria** (all new, all `N`).

| ID   | criterion                                                                                                                                                                                     | statistical form                                                   | by  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --- |
| A7.1 | Operational duration: at least 3 months of operation on at least 2 independent sites (TRL 8 needs an operational environment, not a test bed)                                                 | sites >= 2 (the company confirms the real number); cycles recorded | M22 |
| A7.2 | Cycle reliability: completed / started cycles >= 95% over the pilot period (baseline 71/90 = 78.9%, EI[118])                                                                                  | n = cycles; Wilson lower reported                                  | M22 |
| A7.3 | Discovery recall on pilot repositories' own history: point >= 50%, n >= 60 pooled, Wilson lower >= 0.38 (the stage-2 form applied to non-own code)                                            | as A2.1                                                            | M22 |
| A7.4 | Actionable precision on pilot repositories, judged by the outcome of the customer's own review (accepted fix / closed with a change vs rejected): point >= 80%, n >= 30, Wilson lower >= 0.65 | as A3.4; outcomes, not an ARIA label                               | M22 |
| A7.5 | Safety: 0 unreviewed writes to a customer repository in observe or suggest mode (checked against the audit log); 0 cross-site data exposures                                                  | counts; 0 required                                                 | M22 |
| A7.6 | Customer-side usefulness (an interview or survey instrument chosen by the company): reported with n; no threshold                                                                             | n = respondents                                                    | M22 |

**Dependencies.** WP2, WP3, WP6; customer contracts and legal terms (company).

**Risks and fallback.**

- No pilot customer signs by M12: pilots run on public repositories under their licences, with maintainers' consent for any suggestion. The
  claim then stays TRL 7 ("demonstrated in a relevant environment outside our repository"), not 8.
- A7.3 not met: we report the recall actually observed with its bound and make no discovery claim for foreign code.
- A pilot reveals a data-exposure defect: stop the site, fix, rerun A6.3; if it recurs, the package is withdrawn from pilots.

**TRL.** 6 -> 8 only if A7.1 to A7.5 hold at 2 or more operational sites; otherwise 7.

### WP8. Independent validation, final proof, compliance and management (M1-M24; peak M16-M24)

**Objective.** Close the evidence: the pre-registered stage-3 improvement test, the commercial-reviewer comparison, independent reproduction of
reported numbers, publication including negative results, and the regulatory, IP and management work an evaluator will ask for.

**Baseline.** Stage-3 definition exists (PLAN:412) and no cycle has run toward it (B1). D-COMP (sandbox repository plus a replay harness for a
commercial reviewer arm) is approved and held (SEQ 2026-10-23; INV:D-FINAL); its exit criterion is not stated in the files read (open question).
The weekly headline metric (change_outcome x merge_record) is defined (PLAN:413) and not produced.

**Deliverables.**

1. D8.1 Stage-3 test: a frozen exam panel, at least 4 periods of 10 cycles, at least 30 real merged changes. `S` (PLAN:412).
2. D8.2 Commercial-reviewer comparison on a sandbox repository (D-COMP). `S` (SEQ); exit to be defined.
3. D8.3 Weekly headline report with n. `S` (PLAN:413).
4. D8.4 Independent reproduction: a party outside the team re-runs reported measurements from a pinned SHA and corpus hash. `N`.
5. D8.5 Public technical report with the baselines (0/13, zoo 3/36, 36.4% A/A) and the final numbers, whatever they are. `N`.
6. D8.6 Compliance workpackage: data protection, AI-regulation classification, software supply chain, FTO analysis; the legal conclusions come from
   the company's counsel, this plan only schedules them. `N`.
7. D8.7 Management: quarterly risk-register review, gate decisions recorded, claim register kept in step with the evidence. `N`.

**Acceptance criteria.**

| ID   | criterion                                                                                                                                                         | statistical form                                                          | tag / pointer                 | by                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------- | --------------------- |
| A8.1 | Stage-3: N >= 40 cycles (>= 4 periods x 10) and M >= 30 real merged changes; slope > 0, 90% CI excludes 0, and no period's lower bound is below the stage-2 floor | slope CI over N; a stage-3 pass without N >= 40 and M >= 30 is not a pass | S: PLAN:412                   | M22                   |
| A8.2 | Weekly headline: change_outcome x merge_record with the same frozen detector set, every rate with n                                                               | n per rate                                                                | S: PLAN:413                   | from M6               |
| A8.3 | Independent reproduction of at least 5 reported measurements: same pass/fail verdicts and counts within the stated bounds                                         | 5 of 5 reproduced; otherwise the discrepancy is published                 | N                             | M22                   |
| A8.4 | Claim register: 100% of statements in the full proposal and the final report carry an evidence pointer and a strength label                                       | count of statements without one = 0                                       | N                             | M2, then each release |
| A8.5 | D-COMP result reported with n and a bound against the commercial reviewer arm; exit rule to be written before the run                                             | to be defined (not in the files read)                                     | S for the arm; criterion open | M20                   |

**Dependencies.** All WPs; stage-3 needs the first gated self-promotion window (A5.6) and the merge lane (A3.7).

**Risks and fallback.** Stage-3 is last and depends on the longest chain; if N < 40 or M < 30 by M22 the application's "improves over time" claim
is not made and the report says so. If the independent reproduction (A8.3) finds a discrepancy, the number is withdrawn and the register
corrected; no claim is allowed to outlive a failed reproduction.

**TRL.** Final qualification across components: 7 -> 8 where WP7 holds.

---

## 5. Which criteria are already scheduled and which are new

| group | scheduled in the internal plan (`S`, `S*`)                                       | new for this application (`N`)                      |
| ----- | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| WP1   | A1.1, A1.2, A1.3, A1.4 (fixture form), A1.5; D1.4 threshold registration is `S*` | A1.4 n_AA, A1.6, A1.7, A1.8                         |
| WP2   | A2.1-A2.10 (A2.1, A2.7 are `S*`)                                                 | D2.6 zoo rerun (reported, not gated)                |
| WP3   | A3.1-A3.6 (A3.4 is `S*`)                                                         | A3.7, A3.8, A3.9                                    |
| WP4   | A4.1-A4.5; A4.7 rule                                                             | A4.6, A4.7 count >= 1                               |
| WP5   | A5.1-A5.6 (A5.4 is `S*`)                                                         | A5.7 (external audit, as a human third party), D5.5 |
| WP6   | none                                                                             | all                                                 |
| WP7   | none                                                                             | all                                                 |
| WP8   | A8.1, A8.2; D-COMP arm                                                           | A8.3, A8.4; compliance, publication                 |

## 6. Milestones (plan, not results)

| month | milestone                                                                                     | measurable test                        |
| ----- | --------------------------------------------------------------------------------------------- | -------------------------------------- |
| M2    | G0 reached                                                                                    | A1.1                                   |
| M3    | provenance field live; pre-registered thresholds with one z                                   | A1.8; D1.4                             |
| M5    | G1 reached                                                                                    | A1.2, A1.5-A1.7                        |
| M6    | measurement report with triple stamps; Board leak probe green                                 | A1.3, A5.1, A5.2                       |
| M8    | quote law, promotion bar, F3.7 replay, finding identity v2                                    | A2.5, A2.6, A3.2, A3.3, A3.5, A4.1     |
| M10   | red-first CI step mandatory; no orphan memory; judge two-bar                                  | A3.1, A4.2, A2.7                       |
| M12   | freeze SHA; one decision-test run; first external install                                     | A2.2-A2.4, A2.8-A2.10, A4.5, A6.2 prep |
| M14   | stage-2 recall and actionable precision; first >= 30 merged ARIA changes if authority granted | A2.1, A3.4, A3.7-A3.9                  |
| M16   | G3 reached; Board audit delivered; genesis result (may be 0)                                  | A5.4, A5.5, A5.7, A4.7                 |
| M18   | first gated self-promotion (may be 0); package security assessment                            | A5.6, A6.5                             |
| M22   | stage-3 evaluated; pilots complete; independent reproduction                                  | A8.1, A8.3, A7.1-A7.6                  |
| M24   | final report and claim register closed                                                        | A8.4, D8.5                             |

## 7. Cross-cutting risks

| risk                                                                      | evidence                                                                                                                   | effect                                     | mitigation / fallback                                                                            |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Operator-act bottleneck and key-person concentration                      | 667 of 720 non-merge commits since 2026-10-15 are under one shared git identity (EI[60]); open operator acts (INV:316-336) | delays G0, B2-B7, merge authority          | second authorised operator (company fact); acts scheduled as dependencies                        |
| Provider dependence and shared quota                                      | WP-P provider matrix (EI[85]); shared weekly quota (MEM)                                                                   | runtime pauses                             | pause-and-resume without loss; second provider per seat (PLAN:97); cost statement by the company |
| Disk and host capacity                                                    | 27 GB free vs 35 GB floor (INV:F0.0); load spikes (MEM:MEMORY.md "Paralel yük sınırı (prod droplet)")                      | capacity-preflight failures, deploy blocks | cap parallel work; clean worktrees; named holds, never silent                                    |
| Correlated model blind spot                                               | PLAN:489-494                                                                                                               | inflated agreement                         | method diversity, fresh-clone witness, reality partition, external audit                         |
| Measurement validity (LLM-written defects, small n, contaminated history) | ZOO:38-41; PREREG:Am3                                                                                                      | overstated results                         | n and Wilson on every rate; zoo never a gate; inconclusive stays inconclusive                    |
| Registry and landing friction                                             | MF-2 pending; 54 old PRs open (INV:F0.5)                                                                                   | slows every package                        | MF-2/MF-3 first (INV:192-193)                                                                    |
| Productization undecided                                                  | MEM:project_aria_direction_2026_10_03.md                                                                                   | WP6-WP7 may be cut                         | decision gate at application time; fallback scope in WP6                                         |
| Throughput of real merged changes                                         | 1 ARIA product PR in history (EI[29])                                                                                      | stage-3 M < 30                             | report actual n; shift stage-3; no claim without n >= 30                                         |

## 8. Facts the company must supply (not in the repository; an evaluator will ask)

1. **Legal entity:** name, registration, legal form and date; SME / start-up status; applicant is a single legal entity or a consortium.
2. **Eligibility:** country of establishment (EU or associated country), ownership and control structure, any non-EU or non-associated control.
3. **Team:** named people, roles, FTE per WP, availability (the operator availability noted in memory is an internal note, not a team plan),
   a second authorised operator, planned hires, who appears in the 3-minute video (at most 3).
4. **Previous funding:** earlier EIC and other EU or national grants, state aid and de-minimis received, pending applications.
5. **Costs and financial plan:** per-WP effort, subcontracting, purchased services (compute, model API, audit, penetration test), indicative
   lump-sum split, own contribution, runway, burn; any blended-finance (investment component) intention and amount.
6. **IP and freedom to operate:** who owns ARIA's code and prompts; contributor agreements; third-party licences and the tools used in the build;
   provider terms for building a commercial product on third-party models; patents, trade secrets, any open-source release plan; the FTO analysis
   the full proposal requires.
7. **Customers and letters of intent:** none exist in the repository; the company names pilot sites, signs the data-processing terms, and
   supplies letters of intent. This plan states no number of sites.
8. **Revenue and market:** current revenue, pricing, market size and segment, competitors (including the identity of the commercial reviewer arm
   for D-COMP), go-to-market, channels (MCP / marketplace / direct).
9. **Product scope decisions:** is ARIA productized for code only or also legal; is the aquaculture SaaS part of the application; is the
   separate-platform and per-customer-install model decided (MEM:project_aria_direction_2026_10_03.md records it as undecided).
10. **TRL declaration:** the component table in section 2 confirmed or changed, and the evidence the company will show for each level.
11. **Regulatory position:** data-protection role, classification under the EU AI regulation, security posture and certifications, ethics
    self-assessment, data-management plan, gender and diversity plan.
12. **Infrastructure and sovereignty:** where the Board vault, runner and state live; any non-EU hosting or provider the evaluators may query.
13. **Operator decisions that gate the plan:** A2 permanent human list, A3 unfreeze / revert-merge adjudication, A4 funnel activation, A5 continuous
    cycles, A6 provider for cycles, A7 merge authority (PLAN:467-476); plus the three setup acts (Board enrolment signature, Board and runner
    Claude token, GitHub App settings: OPTODO #1-#3).

## 9. FORBIDDEN statements (must never appear in the application)

| statement                                                                                                    | why                                                                                                      | pointer                   |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| "ARIA does not hallucinate" / "has no false positives"                                                       | 60.6% of detector verdicts were false (n = 325); 8 of 13 promotions are not ground truth; 0 human labels | EI[6], EI[96], EI[99]     |
| "ARIA is self-improving" (present tense)                                                                     | 0 self-made changes, 0 genesis drafts, 0 calibrated judges                                               | EI[107], EI[109], EI[100] |
| Any discovery recall above the measured 0 of 13, or any claim that ARIA finds more defects than plain Claude | decision test run 0 of 35; zoo 3/36 vs 35/36                                                             | EI[91], EI[125], ZOO:14   |
| "ARIA merges autonomously" / "autonomous maintenance" as a general capability                                | one human-merged PR, 0 of 352 auto-merges, 0 backend changes                                             | EI[29], EI[35], EI[36]    |
| Presenting the 133 PRs, 19 capabilities, 338 test files or the Examination Board design as ARIA's work       | engineering by sessions and the operator; none exercised by the runtime                                  | EI§4, EI[60], EI[63]      |
| "ARIA is running" / "in operation"                                                                           | runtime paused since 2026-10-16                                                                          | EI[26], EI[123]           |
| "Customers", "pilot sites", "letters of intent", revenue figures                                             | none exist in the repository                                                                             | section 8                 |
| "Two independent model families judge every finding"                                                         | 40 of 45 consensus rows only; the anchor law is on 3 seats                                               | EI[121]                   |
| Using the 13 rollbacks or the synthetic zoo as a gate or as a recall estimate                                | contaminated or LLM-written; n small                                                                     | PLAN:464, ZOO:38-41       |
| "TRL 6 demonstrated" for any component, including the integrity layer (TRL 5 in the TRL file)                | lower per component                                                                                      | section 2                 |
| "Memory improves ARIA's results"                                                                             | injection proven; effect n = 0                                                                           | EI[106]                   |
| "Fully human-free" self-approval                                                                             | decision A3 open; two human steps remain if "no"                                                         | PLAN:375                  |

## 10. Open questions for the operator

1. Does the application declare a blanket TRL 6 start, or the component table in section 2? The evidence supports no component at TRL 6 (5 at most, the integrity layer); a blanket TRL 6 would contradict the TRL file.
2. Is productization (WP6, WP7) decided? If not, drop both and cap the TRL target at 7 in our own repository.
3. Is the legal-domain pack in or outside the scope?
4. Which single z does `genesis_policy` register for Wilson bounds (section 2, point 3)?
5. Who is the external auditor and what exactly is "WP-X" (A5.7)? Human third party, or an external model seat?
6. What is D-COMP's exit criterion (A8.5)? It is not in the files read.
7. Are the new criteria (A1.6-A1.8, A3.7-A3.9, A4.6, WP6, WP7, A8.3-A8.4) accepted, with their proposed numbers (20% stale, 10 of 30 backend, 200 A/A trials)?
8. Who is the second authorised operator, and what is the plan for the quota and provider cost?
9. Will the company decide A7 (merge authority) before M12, so A3.7 can start?
