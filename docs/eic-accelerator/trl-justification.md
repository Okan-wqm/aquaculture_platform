# ARIA - TRL justification per component (EIC Accelerator short application)

Status: DRAFT for operator review, written 2026-10-26. Not for sending outside before review.
Scope: technology readiness level (TRL) of five ARIA components, with the evidence, the single weakest point, and what must be shown to reach the next level.
Rule followed throughout: do not round up. Where two readings are possible, the lower one is the headline and the higher one is argued separately.

## 0. How to read this file

### 0.1 Strength labels (one per statement)

| Label              | Meaning                                                               | Tense used                           |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------ |
| PROVEN             | verifiable now by anyone with repo access (git, gh, the state branch) | present                              |
| PARTIAL            | true but n is small, one instance, one run, or measured by us offline | past, with n                         |
| BUILT_NOT_MEASURED | code is merged and tested, nothing has measured its effect            | "built and tested, not yet measured" |
| NOT_YET            | not built, not run, or not measured                                   | future, with date and criterion      |
| FORBIDDEN          | we must never claim it (section 9)                                    | not used                             |

### 0.2 Attribution tags (never mix them)

- [A] = ARIA runtime result: produced by ARIA's own cycles on `aria/state`, before the pause.
- [B] = engineering by Claude Code sessions and the operator on ARIA's code, or an offline measurement by the session lead. Never ARIA's achievement.
- [C] = bookkeeping automation under ARIA's GitHub App identity. Not ARIA runtime and not counted.

### 0.3 Evidence pointers

- `INV[n]` = `/var/aqua-kampanya-ciktilari/aria-eic-2026-10/evidence-inventory-2026-10-25.json`, `rows[n]` (0-based). It is the same number as the `#` column in the appendix of `evidence-inventory-2026-10-25.md`.
- `INV-§k` = section k of `evidence-inventory-2026-10-25.md`.
- `ST[id]` = row `id` of `/root/aria-handover/2026-10-21/INVENTORY-2026-10-26.md` (what is built, merged, unpushed, not started).
- `PLAN:n` = line n of `/root/aria-handover/2026-10-21/PLAN-v2.md`.
- `ZOO` = `/root/aria-handover/2026-10-21/zoo/ZOO-REPORT.md`. `ARM` = `/root/aria-handover/2026-10-21/zoo/arms/ARM-REPORT.md`.
- `PROG date` = a dated line of `/root/aria-handover/2026-10-21/PROGRESS.md`.
- `LIVE` = a read-only check I ran on 2026-10-26 against origin (listed in Appendix A).
- `PR #n` = pull request in Okan-wqm/aquaculture_platform.

### 0.4 Pins

- Code: evidence inventory pinned `origin/main` 59d0c6444 (2026-10-25T13:28Z). Status inventory pinned 61d594f02 (2026-10-26). At my check `origin/main` was 33de2433b (merge of #2123, 2026-10-26T11:32Z). Nothing merged between the pins changes any TRL below.
- Live state: `origin/aria/state` 8e39b2eeb, published 2026-10-16T14:41:04Z. Unchanged at my check (LIVE).

## 1. Facts that bound every TRL in this file

1. ARIA's runtime has been paused since 2026-10-16. PROVEN. Evidence: `aria/state` has no publish after 2026-10-16T14:41:04Z (INV[62], INV[26]); seven runtime workflows are `disabled_manually` (6 on 2026-10-16, merge-runner since 2026-09-28) (INV[37]); LIVE re-check 2026-10-26: aria-auto-cycle, aria-agent-executor, aria-agent-eval, aria-daily-report, ARIA External Watchdog, ARIA State Maintenance and aria-merge-runner are all `disabled_manually`; last auto-cycle run 2026-10-16T09:05:49Z, last executor run 2026-10-16T12:43:02Z.
2. Every runtime number in this file is therefore a number from ARIA's code as it stood at its last cycle head (b743e27c3, last cycle completed 2026-10-16T11:24Z) and a state frozen on 2026-10-16. PROVEN (INV-§0, INV[65]).
3. Since 2026-10-15, 133 PRs merged to main; 720 non-merge commits; 0 by `aria-implementer`; 667 by the operator identity (which Claude Code sessions use). 19 capabilities are merged and test-pinned. None has been exercised by ARIA's runtime (0 of 74 cycle heads contain any of them). PROVEN (INV[58], INV[60], INV[63]). This work makes the claims measurable. It is [B] and is not evidence that ARIA does what the claims say (INV-§4).
4. The relevant environment is the applicant's own production monorepo (17 backend services, React microfrontends, a Rust gateway; real CI with required checks). It is one repository, owned by the applicant, and the same repository holds ARIA's own code. There is no second codebase and no external user. PROVEN as a description of the facts; it limits how much "relevant environment" is worth (section 2.2).

## 2. TRL definitions used and what "relevant environment" means here

### 2.1 Definitions

Horizon Europe General Annex G, as I recall it (I did not fetch it for this draft; the operator should paste the exact wording from the call document before submission):

- TRL 3: experimental proof of concept (analytical and laboratory studies of separate elements).
- TRL 4: technology validated in a laboratory.
- TRL 5: technology validated in a relevant environment.
- TRL 6: technology demonstrated in a relevant environment.
- TRL 7: system prototype demonstration in an operational environment.

### 2.2 Why the production monorepo is a defensible "relevant environment", and where it is not

For: it is a real multi-service codebase with real CI, required status checks, branch protection, code owners, migrations, schema-drift gates and a human review culture. ARIA's plans, PRs and refusals happened there, not in a toy repository. A defect ARIA flagged (LeavesPage status filter, F-015) was a real defect in that product (INV[10], INV[29]).

Against (an evaluator will say this): one repository; the applicant wrote both ARIA and the code it maintains; ARIA's own code is inside the repo it maintains, so independence is limited; no customer repository, no second team, no unseen codebase. Treat the environment as "relevant" for TRL 5 and "arguably relevant" for TRL 6.

## 3. Summary

| Component                                                         | Honest TRL                                                                    | Strength of the headline                                  | TRL 6 arguable?                                   | Weakest point (one)                                                                                                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Maintenance pipeline find -> judge -> plan -> implement -> PR | **4 as a whole; 5 (lower end) for the plan -> implement -> PR segment**       | PARTIAL (n = 1 end to end)                                | Only for the segment; not claimed                 | End-to-end rests on n = 1: operator-chosen task, human rescues, human merge; discovery recall 0 of 13                                                                     |
| (b) Evidence-bound memory, hash-chained ledgers                   | **5 for admission law and ledger integrity; 4 for "memory changes outcomes"** | PROVEN for integrity and admission counts; effect NOT_YET | Arguable for integrity and admission; not claimed | "Evidence-bound" means the cited file exists, not that it supports the claim (quote law 0 of 2,364 live); ledgers unsigned, provenance cannot separate ARIA from operator |
| (c) Change review / discovery path (D1-D4; D3 in progress)        | **3 as a path; 4 for individual merged elements**                             | BUILT_NOT_MEASURED (elements); NOT_YET (path)             | No                                                | The path cannot yet produce a finding (D3 unmerged), has 0 live runs, and the only strong detection result in our data belongs to a plain LLM, not to ARIA                |
| (d) Self-improvement                                              | **3**                                                                         | NOT_YET as a loop                                         | No                                                | The loop has never closed once: 0 self-made changes, 0 genesis drafts of 35 requests, 0 real paired gain tests                                                            |
| (e) Examination Board                                             | **2**                                                                         | NOT_YET                                                   | No                                                | Most of the Board is design only; B0 is an unmerged PR needing the operator's signature; no exam runner exists                                                            |

## 4. (a) The maintenance pipeline: find -> judge -> plan -> implement -> PR

### 4.1 Honest TRL

TRL 4 for the pipeline as a whole, because the find stage is a critical element and has not been validated against its requirement in the relevant environment. TRL 5, lower end, for the plan -> implement -> PR segment. I do not claim TRL 6 for any part (section 4.4). The TRL 5 (lower end) reading of the plan -> implement -> PR segment rests on n = 1 human-merged change, 2 of 5 implementation requests reaching a CI-green PR and unmeasured plan quality; TRL 4 is the safer reading, and the operator should choose it for the headline if an evaluator is likely to press on n = 1.

### 4.2 Stage by stage

| Stage        | TRL                                                   | Evidence (label; pointer)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Find         | 4                                                     | 15 adapters registered, 0 ACTIVE (6 SHADOW, 8 CALIBRATE, 1 QUARANTINED); last cycle 14 of 14 tool runs OK, 0 operator-facing findings (PROVEN; INV[0], [A]). 22 findings committed, none since 2026-10-14T21:58Z (PROVEN; INV[3], [A]). Only human-reviewed sample of the drift scan (2026-09-09): 4 signals, 1 real defect (LeavesPage.tsx:346, later F-015), 3 false positives, so 1 of 4, Wilson 95% [4.6%, 69.9%] (PARTIAL; INV[10], INV[120]). Judge-measured precision of the adapter battery 128 true of 325 judged (39.4%), 0 human labels (PARTIAL; INV[6], INV[98], INV[8], [A]). Discovery recall on planted real defects: 0 of 13, exact 95% CI [0, 24.7%], a contaminated practice score, recorded and not reproduced (PARTIAL; INV[89], INV[91], [B]). Synthetic pilot, n = 36 LLM-written defects: the current rule-based finding path found 3 (Wilson 95% [2.9%, 21.8%]), 1 for the right reason, logic defects 0 of 12 (PARTIAL; ZOO, [B]). |
| Judge        | 4                                                     | 928 judge requests (evidence 471, adversarial 457); accepted results 181 and 154; 45 consensus rows; 16 anchors of which 5 true and 11 false; 0 calibrated judges; max 1 sample per judge (PROVEN as counts; INV[41], INV[7], INV[44], [A]). Offline test of the evidence judge on 30 items: 15 of 15 true claims accepted, 8 of 8 false claims refuted; 7 of 7 true claims with a wrong cited line were accepted at the same confidence (0.80-0.90), so confidence was not informative; the adversarial judge was not run (its declared model is unavailable) (PARTIAL; ARM, [B]). Offline wire test, 27 claims: 13 of 13 true confirmed, 13 of 14 false refuted, by a proxy oracle (PARTIAL; INV[95], [B]).                                                                                                                                                                                                                                                |
| Plan         | 5 (lower end)                                         | 42 plans started; 18 reached convergence at some point (all in round 2), 14 were HUMAN_REQUIRED at their last recorded state and 13 carry an abandoned event (the three counts overlap: 45 > 42); 92 adversarial cross-reviews, 69 raised material risks (PROVEN; INV[27], [A]). The duel rating measures risk-finding, not plan quality (PROVEN; INV[43]). Offline test, 8 findings (6 true, 2 false): 6 of 6 true planned by both planners, 2 of 2 false refused (PARTIAL; ARM, [B]).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Implement    | 5 (lower end)                                         | 5 implementation requests ever; outcomes: 1 merged PR (#1906), 1 PR open (#1946, docs only), 2 rejected (sandbox lacked cargo; CLI exit 124 rollback), 1 with no outcome (PARTIAL; INV[28], INV[38], [A]). So 2 of 5 produced a CI-green PR (Wilson 95% [11.8%, 76.9%]; my arithmetic). 8 envelope refusals on read-only workflow surfaces; 21 hard-fail checks in code (PROVEN; INV[38], INV[23]). 0 backend (`apps/`) paths changed by ARIA (PROVEN; INV[36]).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PR and merge | 5 for opening a PR with green CI; NOT_YET for merging | #1906: plan converged 2026-10-09T07:26:27Z; `aria-implementer` commit 1ac2048c2 at 09:49:45Z (+148/-8, `LeavesPage.tsx` and its spec); PR opened 09:59:47Z; 8 of 8 workflow runs on ARIA's commit green; 32 runs over 4 heads, 31 success, 1 failure (Docker Hub pull rate limit) (PROVEN; INV[29], [A]). Merged 2026-10-10T01:03:06Z by the human account (LIVE; INV[30]). 0 auto-merges of 352 merge decisions, all `eligible=false` and `dry_run=true` (PROVEN; INV[35], [A]).                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 4.3 What the runtime did and what people did (keep apart)

- [A] ARIA detected the drift (as F-002, 2026-08-17T15:43Z), converged the plan, wrote the fix and test, opened the PR and saw CI pass (INV[31], INV[29]).
- [B] Human acts on #1906: the merge click; 3 update-branch merges (7b80bb99b, e007d32e9, 422cd0881); kernel fix #1932 (ARIA-HIGH-409) merged 2026-10-10T07:58:28Z by the human account. Two further rescues (a plan withdrawal with a re-published request, a `chown` of the runner workspace) are not visible in git or state and are carried only from the older inventory (PARTIAL; INV[30]).
- [B] The task was chosen from operator requests: three requests for F-015 and one for F-007; the cycle selected OP-F015-20261008-2 (PARTIAL; INV[31]).
- [A] The last task ARIA selected on its own before the pause (F-014, 2026-10-16T11:58Z) did not converge: plan reached HUMAN_REQUIRED in round 2, no implementation request, no PR (PROVEN; INV[34]).
- [A] Orchestrator: 90 `autonomy_orchestrator_exit` rows (71 max_cycles, 19 cycle_failed); cycles 90 started, 71 completed (78.9%, Wilson 95% [69.4%, 86.0%]). Across the exits the audit found 0 worker assignments and 0 auto-merges (audit of 2026-10-15, not re-derived). Only 2 `implementation_delivered` rows exist in total; 58 converged deliveries were not counted for lack of implementation authority (PARTIAL; INV[111], INV[118]).
- [A] Throughput: 833 of 2,313 agent requests (36.0%) ever received a result; 1,382 (59.7%) were refused as stale (PROVEN; INV[118]).
- [B] Everything merged after 2026-10-15 for this pipeline (WP-J expert panel, F2.3 one acceptance bar, D5 red-first prover, F1.7, J1, J2, J5, SE-1, SE-2, SE-3, SE-13 and others) is built and tested, not yet measured; none ran in a live cycle (BUILT_NOT_MEASURED; INV[63], INV[65]-INV[84]). The WP-J judgment funnel ships off (INV[65]).

### 4.4 Is TRL 6 arguable? Yes, for the segment only. The argument, and why we do not claim it

The argument for TRL 6 (what an optimistic reading would cite):

- A real production monorepo with real CI is a relevant environment for a maintenance tool.
- One plan went end to end to a merged pull request: #1906, 8 of 8 runs green on ARIA's commit, fix still present on main (PARTIAL; INV[29], INV[32]).
- 90 orchestrator exits and 60 `observe_success` acceptance rows show the machine ran repeatedly in that environment (INV[111], INV[112]).

Why we do not claim it:

- n = 1 merged PR, front-end only, one file plus its spec. The merge needed human acts (INV[30]).
- The task was operator-chosen (INV[31]).
- The 60 `observe_success` rows come from 2 operator-dispatched burn-in reports (2026-10-04 to 2026-10-08), and ARIA-CRITICAL-015 (open) records that acceptance rows carry no verified outcome (INV[48], INV[112]).
- 0 of 352 merge decisions allowed an auto-merge; the merge workflow has been disabled since 2026-09-28 (INV[35]).
- ARIA's runtime has been paused since 2026-10-16, and the code that was built afterwards has not run (section 1).
- The find stage is at TRL 4 (0 of 13; 3 of 36).
- "Demonstrated" at TRL 6 implies a representative prototype operating without hand-holding. #1906 needed hand-holding.

### 4.5 Weakest point an evaluator would attack

The end-to-end claim rests on one case that the operator selected and that needed human rescues; nothing in the record shows ARIA finding and fixing a real defect on its own, and its measured discovery recall is 0 of 13.

### 4.6 To reach the next level

TRL 4 -> 5 for the pipeline as a whole (pre-registered, PLAN:405-409; INV-§5):

- G0: at least 3 consecutive clean measured cycles in operator-opened observe-only mode (PLAN:405).
- Discovery recall on real regressions (SZZ replay plus planted mutants): point estimate at least 50%, n at least 60, Wilson lower bound at least 0.38, stratified by source (PLAN:407-408).
- Actionable precision of what ARIA reports: point estimate at least 80%, n at least 30, Wilson lower bound at least 0.65 (PLAN:409).

TRL 5 -> 6 (the pre-registered parts; the last line is my proposal and is not pre-registered):

- Q2 acceptance scenario with no human line (PLAN:441-454) and the decision test D-FINAL, run once on the sealed held-out set: ARIA beats plain Claude and the three-lens group in recall, one-sided exact McNemar p < 0.05 against each, and does not report more per clean commit (INV[125]).
- Proposed, not pre-registered: at least 5 consecutive rescue-free merged changes, at least one in `apps/`, each chosen by ARIA from its own findings.

Proposed dates (operator to confirm; each depends on operator acts listed in `ST` "Operator acts", e.g. B0 enrolment signature, runner token, runtime-profile ceiling): G0 by [2026-12-31]; discovery and actionable-precision thresholds measured by [2027-03-31]; D-FINAL once by [2027-03-31].

## 5. (b) Evidence-bound memory and hash-chained ledgers

### 5.1 Honest TRL

TRL 5 for the admission law and ledger integrity. TRL 4 for the claim that memory changes outcomes. I do not claim TRL 6 (section 5.4).

### 5.2 Evidence

Integrity and admission, ARIA runtime [A] (the verifiers were run offline by the inventory team on the frozen state; ARIA itself was not running):

- 71 ledger files, 63,331 rows, 0 broken hash chains, under both the 59d0c6444 kernel verifier and the older be8f1d1c8 one (PROVEN; INV[21]). All 182 non-empty `tools/` ledgers, 86,556 rows, valid (PROVEN; INV[57]).
- 28 of 28 ledgers checked are prefix-continuous: history was never rewritten between the two snapshots (beliefs 358 -> 366, governance 28,141 -> 29,056, plans 342 -> 367, results 763 -> 833) (PROVEN; INV[53]). `aria/state` has 286 publishes since 2026-08-05T10:22Z and the old pin is an ancestor of the new tip (PROVEN; INV[26]).
- Every one of 22 committed findings cites code that exists exactly as cited: 110 of 110 refs resolve at their pinned commit by `git show` plus sha256 (PROVEN; INV[5]). The citation is real; that does not show the claim is true.
- Agent outputs citing unverifiable evidence are refused live: 833 results (766 accepted, 67 rejected), 59 rejected under the evidence law (PROVEN; INV[15]).
- 347 memory-belief candidates were refused (289 `glob_too_large_to_verify`, 58 `empty_glob`); 9 beliefs admitted, all supported and verified (PROVEN; INV[16], INV[50]).
- 70 plan-intake refusals for subjects that cannot be verified (PROVEN; INV[17]).
- 2,313 of 2,313 agent requests carry evidence refs; 1,382 refused as stale rather than answered on an old snapshot (PROVEN; INV[18]).
- Hard-fail safety checks: 21 entries in code (PROVEN; INV[23], [B]).

Memory in use [A]:

- Decision memory reached 1,588 of 2,313 requests (none in August); past rejected attempts 1,156 (PROVEN as counts; INV[52]). Effect on outcomes was never measured, n = 0 (NOT_YET; INV[106]).
- Belief decay: synthetic acceptance scenarios 4 of 4 passed (stale belief decays, consensus disagreement escalates, runtime signal becomes pressure, runtime signal reopens belief) (PARTIAL; INV[54], [B]). Live: 21 `needs_revalidation` rows each re-supported within 30 s; 0 contradiction rows; the age, head-distance, PR-impact and runtime-signal decay triggers fired 0 times (PARTIAL; INV[54], INV[55], INV[105]).
- Conventions: 10 rows, 0 with claim text; lessons reach 0 of 2,313 envelopes as anti-patterns (NOT_YET; INV[103], INV[104]).

Engineering after the pause [B], built and tested, not yet measured: F2.3 one acceptance bar, 58 tests passed (PR #2104); J1 stale suppression, 6 passed (PR #2108); J2/J5 judge-contract scoping, 82 passed (PR #2099); MF-1 closure derived from merged `Closes:` trailers (PR #2086); F0.9b ownership atlas (PR #2106). None ran live; 0 of 45 consensus rows carry the new `cited_code_hash`, 0 of 325 judge rows carry `agent_contract_hash` (INV[66], INV[72], INV[73], INV[79], INV[83]). Only memory.py, memory_gap.py and state_compact.py changed under the memory surfaces (33 insertions, 24 deletions): no belief decay or contradiction code was added (PROVEN; INV[90]).

### 5.3 What is not shown

- Quote (citation) law: 0 of 2,364 sampled findings carry a quoted excerpt; every evidence entry is `{path, line}` (NOT_YET; INV[97]). So "evidence-bound" today means "the cited file exists at the pinned commit", not "the cited text supports the claim".
- Provenance: all 29,056 governance rows record `actor.kind = human` (the runner identity), and the ledgers are hash-chained but unsigned. ARIA's acts and the operator's acts cannot be separated by that field (PARTIAL; INV[57], INV[122], ARIA-MEDIUM-029).
- 5 of 13 promoted findings satisfy the ground-truth predicate; 7 rest on a 2-judge pair; 1 has no consensus row; 0 of 45 consensus rows carry a `target_sha` (PROVEN; INV[67], INV[96]).
- Mechanism audit: of 69 self-improvement and memory mechanisms, 5 were WORKING, 64 not, as of the audit of 2026-10-14/15; not redone after 296 kernel module changes (PARTIAL; INV[49], INV[110]).

### 5.4 Is TRL 6 arguable? Yes, for integrity and admission only

For: the laws ran against real agent output for about ten weeks and refused real inputs (347, 59, 70); the verifier found 0 breaks in 63,331 rows. Against: no tamper drill on live or copied state is recorded in the inventory (kernel test files mention tamper and chain checks; I did not run them or check that any is a drill on real state); chains are unsigned; provenance is wrong in all 29,056 rows; the quote law never ran; the memory-effect half has no measurement. Not claimed.

### 5.5 Weakest point an evaluator would attack

"Evidence-bound" is existence-bound: a claim cites a file that exists, and 0 of 2,364 sampled findings carry a quoted excerpt showing the text supports the claim; the ledgers are hash-chained but unsigned, no tamper drill is on record, and the actor field is wrong in every row, so they show internal consistency, not that a deliberate change would be caught.

### 5.6 To reach the next level

TRL 5 -> 6 (the first line is my proposal; the rest are pre-registered):

- Proposed: a tamper drill on a copy of the state (edit, delete and reorder rows; the verifier must flag every case) and signed anchors on the state branch, by [2026-11-30].
- F2.4 live quote law: at least 95% of sampled findings quoted and at least 90% observable coverage (PLAN:232 via INV[97]).
- F0.9p provenance layer and the "no orphan memory" invariant (ST[F0.9p], NOT_STARTED).
- At least one live cycle in observe mode in which the F2.3, J1 and J2 refusal codes appear in the state (they appear 0 times today; INV[24]).
- Memory effect: the final decision-test arms A-learned versus A-empty on the held-out set (PREREG, INV[106]).

## 6. (c) Change review and discovery path (D1-D4; D3 in progress)

### 6.1 Honest TRL

TRL 3 for the path. TRL 4 for the individual merged elements. No TRL 6 argument is available.

### 6.2 Evidence

Merged, built and tested, not yet measured [B]:

- D1 (PR #2094, 6d9b77d75): hermetic single-change entry (`cycle run --mode change_review`, `harness review-change`); 18 passed, 60 subtests on main; its new tests were red at the parent (17 failures across 13 new test names). Invoked by no workflow (BUILT_NOT_MEASURED; INV[69]; LIVE: `git grep change_review` in `.github/workflows` = 0 hits).
- D2 (PR #2110, 0d9ded9da): explicit change subject and context; untrusted text only inside escaped tags (BUILT_NOT_MEASURED; ST[D2], ST[F4.0a]).
- D4 (PR #2122, 61d594f02): per-change budget; `admit_change_claims` has no production caller until D3 wires it (BUILT_NOT_MEASURED; ST[D4]).
- D5 (PR #2102): one red-first prover `prove_red_first`; 24 passed, 28 subtests; no caller yet; the generated atlas lists it as owner none, liveness dead (BUILT_NOT_MEASURED; INV[68], ST[F3.2]).

Not built or not on main:

- D3 (discovery to hypotheses, the contract that makes the path emit defect claims) is running as a build workflow, not merged (NOT_YET; ST[D3], PROG 2026-10-26 14:35Z entry; LIVE: not among merges to main at my check).
- D6 and D9 are built and unpushed (no remote ref); D7, D8, D10 and D12 are not started; D-FINAL is not started (ST[D6], ST[D9], ST[D7], ST[D8], ST[D12], ST[D-FINAL]).
- 0 change reviews have run on live state (NOT_YET; INV[126]).

Offline measurements by the session lead [B], on a pinned snapshot, defects written by an LLM, diffs small, n small, one run, effort "high" while ARIA's own setting is "max":

- ARIA's own change-intelligence role prompt, run as an agent on 14 diffs (12 defect, 2 harmless): called out the labelled defect on 11 of 12 (Wilson 95% [64.6%, 98.5%]), matched the label on all 11, missed 1, 0 of 2 false alarms. Its real output contract is an impact map with no field for a defect, so the result is visible only because the test asked for it (PARTIAL; ARM).
- Synthetic pilot, n = 36 defects and 12 harmless controls: ARIA's current rule-based finding path (no LLM) found 3 of 36 (8%, Wilson 95% [2.9%, 21.8%]); four blind plain-LLM reviewers reading only each diff found 35 of 36 (97%, Wilson 95% [85.8%, 99.5%]); 0 of 12 false alarms in both arms. The single plain-LLM miss (Z08, a missing test for a correct function) is arguably not a defect (PARTIAL; ZOO). This is a pilot, not a recall estimate; the labels and the reviewers come from the same model family; each reviewer saw one small diff, which is easier than discovery in a whole tree; it is not the sealed real-defect set (ZOO "Limits").
- Real planted defects: 0 of 13 (section 4.2) (PARTIAL; INV[89]).

### 6.3 Why TRL 3 and not 4 for the path

TRL 4 needs integrated components validated in a laboratory. The integrated path (diff in, defect hypotheses out, claims proven red-first, budget enforced) does not exist on main: D3 is unmerged, D5's prover has no caller, D6-D10 are not landed. The critical function (an LLM reviews one change and names the defect) has only an experimental proof of concept, run outside the kernel on LLM-written defects. The individual merged elements are TRL 4.

### 6.4 Weakest point an evaluator would attack

The one strong detection number in our data belongs to a plain LLM (35 of 36), not to ARIA (3 of 36 on the current path, 0 of 13 on real defects), the change-review path that is meant to close the gap cannot yet emit a finding, and the comparison against plain Claude (D-FINAL) has 0 of 35 real cases and 0 of 120 clean controls run (INV[125]).

### 6.5 To reach the next level

TRL 3 -> 4 (thresholds from DESIGN-discovery as quoted in INV[126]; the date is my proposal):

- D3 merged and the D1-D4 path run end to end on the DEV cases, by [2026-12-15].
- Hypothesis recall on DEV at least that of plain Claude (arm B) on DEV.
- Prover self-check classifies the DEV fix tests "proven" in at least 95%.
- Proven claims that a blind judge calls real defects: at least 0.9 (point estimate).
- Reports per clean commit on DEV at most min(B, C).
- ARIA's recall block agrees 100% with the external scorer.

TRL 4 -> 5: observe-mode runs on real merges (G0), then the stage-2 recall and precision thresholds of section 4.6.

## 7. (d) Self-improvement

### 7.1 Honest TRL

TRL 3. Separate elements exist and some are validated in the laboratory; the loop has never closed. Not TRL 4 because the elements are not integrated: the self-change lane is not on main and no self-made change exists.

### 7.2 Evidence

ARIA runtime [A]:

- 3 detector demotions SHADOW -> CALIBRATE (doc-staleness 2026-09-19, kernel-dead-wire 2026-09-20, lint-rules 2026-10-05), 0 returns; 1 bounded dial step (kernel-dead-wire pressure weight 50 -> 40, 2026-10-08T05:26:32Z); 1 rule quarantined (F-016, 3 of 3 ground-truth verdicts false positive). All rest on AI-judge or anchor labels, not human labels (PARTIAL; INV[11], INV[47]). This is rule-governed adaptation of detector status. It is not an outcome-measured improvement.
- Autonomy ladder: 60 `observe_success` rows (2 operator-dispatched burn-in reports, 2026-10-04 to 2026-10-08), 5 profile changes, last 2026-10-11T20:58:29Z strict -> standard; no merge-lane grant. It acts as a brake (PARTIAL; INV[48], INV[112]).
- Genesis (agents create skills, agents or adapters): 35 requests (20 skill, 15 agent), all `requested`; 0 drafts, 0 materialisations; 10 genesis HUMAN_REQUIRED packets open. All 15 adapters and the aria agent prompts were written by hand (NOT_YET; INV[45], INV[107]).
- Self-change lane: 195 missions opened, 7 of them `propose_self_change`; the scheduler made 74 decisions, 73 for the same mission, 0 for a self-change mission; 26 proposals, all of kind `architecture`; no governance row of kind self_change, kernel_change, self_revert or self_merge (NOT_YET; INV[46], INV[109]).
- Mechanism audit: 5 of 69 WORKING (7.2%), as of 2026-10-14/15, not redone (PARTIAL; INV[49], INV[110]).
- A statistically valid gain test was never used live: the agent-eval ledger holds 35 runs, all `mock_mode=true`, on 5 fixtures; the older comparator would have declared "improved" for two identical agents (p = 0.7, 5 runs per window) in 36.4% of cases (analytic reproduction by the inventory author, INV[108]) (NOT_YET).

Engineering after the pause [B], built and tested, not yet measured:

- F1.7 (PR #2103): paired exact-McNemar gain test, mock runs refused, thresholds pre-registered (alpha 0.05, at least 6 discordant pairs, at least 3 duel matches, 30-day window); 18 passed, 12 subtests, jest 6 of 6; its new tests were red at the parent (21 failures across 12 new test names). Known gaps ARIA-HIGH-944 and ARIA-MEDIUM-946. 0 real paired runs exist (BUILT_NOT_MEASURED; INV[70], INV[108]).
- B1 (PR #2087): derived authority set, so ARIA cannot write the files that govern it; 97 passed, 23,232 subtests (BUILT_NOT_MEASURED; INV[78]).
- F0.8 one diversity function (PR #2095) and WP-P seat law (PR #2044): the anchor counts distinct judge seats, not model families (operator decision 2026-10-18) (BUILT_NOT_MEASURED; INV[71], INV[85]).
- F0.4c `kernel_change_lane` (the lane through which an adjudicated self-change reaches an operator-opened PR) is built but unpushed (two local commits, 833 commits behind main); `kernel_change_lane.py` and `admit_kernel_change` are absent from origin/main (LIVE; ST[F0.4c]). F0.4b genesis router likewise unpushed (ST[F0.4b]).

### 7.3 Weakest point an evaluator would attack

No self-made change has ever existed: 0 self-change proposals of 26, 0 genesis drafts of 35 requests, 0 real paired gain tests, 5 of 69 mechanisms working, and the lane that would carry a self-change is not on main.

### 7.4 To reach the next level

TRL 3 -> 4 (my proposals for the first three; the rest pre-registered):

- F0.4c landed on main, by [2026-12-15] (operator-dependent: needs PV #2109 and B0 #2093 landed or rebased).
- First paired gain test on real (non-mock) runs through F1.7, with at least 6 discordant pairs (genesis_policy_default superiority block, INV[108]).
- First self-change proposal that reaches the lane's adjudication step on live state (0 today).
- G1: 14 consecutive cycles in which every field of the F1.2 scorecard field list is measured (PLAN:406; F1.2 is NOT_STARTED, ST[F1.2]).

TRL 4 -> 5: first real self-promotion needs G1 and G3 and stage-2 and the B4 seams (PLAN:411). Not before the Board exists (section 8).

## 8. (e) Examination Board

### 8.1 Honest TRL

TRL 2. The concept and its application are formulated in detail (PLAN-v2 phase 6, 8 seams inventoried, refuted by 3 independent agent reviewers who raised 56 findings, all addressed in the plan, PLAN:3-36); one element is at TRL 3-4 (B1); the critical function (an independent, signed verdict on a self-change) has no proof of concept.

### 8.2 Evidence

- B1 derived authority set: merged (PR #2087, cfa739f1f); 97 passed, 23,232 subtests; the test file did not import at the parent (BUILT_NOT_MEASURED; INV[78], ST[B1]). The point where it is applied for self-changes (`kernel_change_lane`) is not on main (LIVE; ST[F0.4c]).
- B0 Board identity, vault cipher, job guard, stop switch: PR #2093 is OPEN, `mergeStateStatus` DIRTY, 51 commits on the head, 241 commits behind main at the inventory; seven review rounds ended in tracked findings; needs the operator's enrolment signature (LIVE: state OPEN, DIRTY, CONFLICTING, head ee4588b86; ST[B0]). Not merged, so not exercised.
- `examination_board.py` exists only on the B0 branch; not on main (LIVE: `git ls-tree` on origin/main returns no such file).
- Operator setup done 2026-10-21: GitHub environment `aria-board` and the private vault repository `Okan-wqm/aria-board-vault` exist (ST "Operator acts" B1, B3). `vars.ARIA_STOP` does not exist (3 variables only); runner and Board provider token absent (ST "Operator acts" B4, B6).
- B2 (exam runner, signed verdict), B3 (blind witness), B4 (8 seams), B5, B6, B7 (drill, G3, external audit): NOT_STARTED, no code (ST[B2]-ST[B7]).
- Everything the Board depends on at the planning level (F1.7, D5, B1) is built and tested, not yet measured; no Board decision, drill or exam exists.

### 8.3 Weakest point an evaluator would attack

Most of the Board is a plan: B2 to B7 have no code, B0 cannot be merged without the operator's own signature, and the planned approval of self-changes with no human line has never been tried once.

### 8.4 To reach the next level

TRL 2 -> 3: B0 merged (needs the operator enrolment signature, `board/ENROL-STEP.md`), B2 exam runner producing one signed verdict on a seeded case, and the vault-leak probe turning from red to green (PLAN:322-340 as the design).
TRL 3 -> 4: G3 as pre-registered: B7 drill 100%, at least 30 seeded decisions with agreement Wilson lower bound at least 0.85, 7 Board-shadow cycles (PLAN:410). Dates: depends on the operator's signature; proposed B2 first verdict by [2027-01-31], G3 by [2027-04-30].

## 9. Statements we must never make (FORBIDDEN)

- That ARIA "does not hallucinate", or that its output "is verified true". It verifies that cited files exist (110 of 110) and refuses unverifiable references; it never showed that a cited text supports a claim (0 of 2,364 quoted).
- That ARIA "is self-improving" or "improves itself" in the present tense. No self-made change exists (section 7).
- Any discovery recall figure above the measured 0 of 13 (exact 95% CI [0, 24.7%]), or a recall figure from the synthetic zoo. The zoo shows 3 of 36 for the rule path and 35 of 36 for a plain LLM; it is a pilot.
- That ARIA merges code on its own (0 of 352), or that it ran an autonomous end-to-end maintenance cycle without human acts (#1906 needed them).
- That ARIA changed backend code (0 `apps/` paths).
- That ARIA's runtime ran the capabilities merged after 2026-10-15 (0 of 74 cycle heads contain them). Anything merged after the pause is engineering [B].
- That the Examination Board exists as a working system, or that self-changes are approved by it.
- That the ledgers are signed, or that provenance separates ARIA from the operator.
- That ARIA is "currently running". It has been paused since 2026-10-16.
- That "two independent model families judge" every finding: 40 of 45 consensus rows pair Opus with GLM-5.3; the code gate counts seats, not models (INV[19], INV[121]).
- That ARIA beats plain Claude. D-FINAL has run 0 of 35 real cases.
- Presenting the 60 `observe_success` rows or the 90 orchestrator exits as evidence of autonomy. They show the machine ran, not that its output was right (INV[112], INV[111]).

## 10. What this file did not verify

- I did not re-run any ARIA test or verifier. Counts come from the evidence inventory (built 2026-10-25 by four readers) and the status inventory (2026-10-26), whose own caveats apply (INV-§6, ST "Method notes and limits").
- I did not re-score the zoo (`zoo/scored.json`); ZOO-REPORT figures are quoted as written. The two Wilson intervals for 3 of 36 and 35 of 36, and the intervals for 11 of 12 and 2 of 5, are my arithmetic.
- The 69-mechanism audit, the two of the three #1906 rescues that are carried only from the older inventory, the 71 `cost_attribution_missing` rows and the 502 open HUMAN_REQUIRED items (ARIA's own report) are carried and not re-derived.
- The TRL definitions are quoted from memory (section 2.1).
- The sealed files (`decision-test/cases.jsonl`, `SPLIT*`, held-out files, `zoo2`) were not read.
- Dates in brackets are proposals for the operator to confirm or change. None is a commitment I can make.

## 11. Paste-ready TRL paragraph

> **Technology readiness (self-assessment, 2026-10-26).** We assess ARIA, our evidence-bound system for maintaining a production code repository, component by component, and we do not claim TRL 6 for any component. The relevant environment is our own production monorepo with real continuous integration; it is one repository, and ARIA's own code lives in it. ARIA's runtime has been paused since 2026-10-16; the runtime figures below come from its live operation between 2026-08-05 and 2026-10-16 (state frozen at the end date), the test and pilot figures were measured offline by us on its code and prompts, and none of the 19 capabilities merged since has yet run in a live cycle.
> **(a) Maintenance pipeline (find, judge, plan, implement, pull request): TRL 4 as a whole, TRL 5 (lower end) for the plan-to-pull-request segment.** ARIA started 42 plans, converged 18, and took one to a CI-green pull request (#1906, 8 of 8 runs on its commit); a human merged it after manual rescues, on a task the operator had selected (n = 1; 0 of 352 merge decisions were autonomous; 0 backend changes). Discovery recall on 13 planted real defects was 0 of 13 (95% CI 0 to 24.7%), which is why the whole pipeline sits at TRL 4.
> **(b) Evidence-bound memory and hash-chained ledgers: TRL 5 for admission and integrity, TRL 4 for memory effect.** Every committed finding cites code that exists as cited (110 of 110 references); 347 unverifiable belief candidates and 59 of 833 agent results were refused; 71 ledger files with 63,331 rows have 0 broken hash chains. The effect of memory on outcomes has not been measured (n = 0), the quoted-evidence law has not been applied to live findings (0 of 2,364), and the ledgers are not signed.
> **(c) Change-review and discovery path: TRL 3 as a path, TRL 4 for its merged elements** (built and tested, not yet measured). In a synthetic pilot of 36 LLM-written defects, the current rule-based finding path found 3 and a plain LLM reading the diff found 35; the change-review path meant to close that gap has not yet run on live state.
> **(d) Self-improvement: TRL 3.** Separate elements are built and tested (a paired statistical gain test, a derived authority set); ARIA has made no self-initiated change (0 of 26 proposals, 0 of 35 genesis requests drafted), and the loop has not closed.
> **(e) Examination Board for independent approval of self-changes: TRL 2.** The design is written (PLAN-v2 phase 6); one element, a derived authority set, is merged and tested, not yet measured; the identity, vault and stop-switch package is an open pull request that needs our enrolment signature; and no exam runner exists.
> **Next measurable steps.** We will run ARIA in operator-opened observe-only mode and show at least 3 consecutive clean measured cycles by [2026-12-31]; we will measure discovery recall on real regressions (target: at least 50%, n at least 60, Wilson lower bound at least 0.38) and actionable precision (at least 80%, n at least 30, Wilson lower bound at least 0.65), and run a single pre-registered comparison against plain Claude on a sealed set of 35 real regressions and 120 clean controls (one-sided exact McNemar p < 0.05), by [2027-03-31]. If those results do not meet the thresholds we will report them as they are.

Short form (about 60 words): "ARIA is at TRL 4 as a maintenance pipeline (TRL 5, lower end, for plan to pull request, n = 1 merged change with human help), TRL 5 for evidence-admission and ledger integrity, TRL 3 for change review and self-improvement, and TRL 2 for the independent Examination Board. Its runtime has been paused since 2026-10-16. We do not claim TRL 6."

## Appendix A. Checks I ran on 2026-10-26 (read-only)

- `git fetch -q origin main aria/state` in `/var/aqua-saas/.worktrees/land-check` (updates remote-tracking refs only). `origin/main` = 33de2433b (2026-10-26T12:32:28+01:00, merge of #2123); `origin/aria/state` = 8e39b2eeb (2026-10-16T16:41:04+02:00).
- `gh api repos/Okan-wqm/aquaculture_platform/actions/workflows`: seven ARIA runtime workflows `disabled_manually`; `gh run list --workflow aria-auto-cycle.yml --limit 1` = created 2026-10-16T09:05:49Z; `aria-agent-executor.yml` = 2026-10-16T12:43:02Z (conclusion failure).
- `gh pr view 1906`: MERGED 2026-10-10T01:03:06Z, merged by the human account `Okan-wqm`.
- `gh pr view 2093`: OPEN, DIRTY, CONFLICTING, head ee4588b86, 51 commits.
- `git ls-tree -r origin/main`: no `examination_board`, `kernel_change_lane` or `genesis_seed` file; `ownership_atlas.py` present. `git grep change_review origin/main -- .github/workflows`: 0 hits. `self_improvement.derived_authority_set` present (line 592).
- `gh pr list --state merged --limit 12`: #2122 merged 2026-10-26T09:27:48Z, #2123 merged 2026-10-26T11:32:28Z; D3 not among them.

## Appendix B. Source files

- `/var/aqua-kampanya-ciktilari/aria-eic-2026-10/evidence-inventory-2026-10-25.md` and `.json` (127 rows)
- `/root/aria-handover/2026-10-21/INVENTORY-2026-10-26.md`
- `/root/aria-handover/2026-10-21/zoo/ZOO-REPORT.md`, `/root/aria-handover/2026-10-21/zoo/arms/ARM-REPORT.md`
- `/root/aria-handover/2026-10-21/PLAN-v2.md` (gates at lines 404-413, Board at 322-395, Q2 scenario at 441-454)
- `/root/aria-handover/2026-10-21/PROGRESS.md` (tail, entries of 2026-10-26)
- repository: `/var/aqua-saas/.worktrees/land-check` (origin/main)
