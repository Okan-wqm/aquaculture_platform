# ARIA quality and learning program v2: registered gaps (2026-10-21)

The operator approved this program on 2026-10-21. It covers finding quality, implementation quality,
learning from memory, and an Independent Examination Board for self-improvement with no human
approval. Each finding below is a gap the program closes. The plan item that closes it is named in
its notes. Registered from stubs re-verified on origin/main 99948cb40.

## ARIA-HIGH-729

genesis_policy.effective_calibration_gate keeps the consensus gate at measure_only unless two
calibrated judges run distinct models, so under a single provider the seat-based calibrated quorum
in feedback_store can never be enforced

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-04.
- Plan item(s): F0.8.
- Evidence:
  - `aria-kernel/aria_kernel/genesis_policy.py:131-159`
  - `aria-kernel/aria_kernel/cycle.py:1918-1922`
  - `aria-kernel/aria_kernel/feedback_store.py:1132-1143`
  - `aria-kernel/aria_kernel/feedback_store.py:150-165`
- Rule: Operator decision 2026-10-18 (WP-P): one provider is enough and diversity is counted by
  judge seats, not models; PLAN-v2 §2 'Çeşitlilik yasası': one seat function with three consumers
  (anchor, calibrated quorum, calibration gate).

## ARIA-MEDIUM-730

Every consensus uncertainty (single_judge, low_confidence, judge_disagreement) ends as a
HUMAN_REQUIRED operator-triage record, a human-label queue the operator ruled out, and no
unverifiable rate is computed or capped

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F0.7.
- Evidence:
  - `aria-kernel/aria_kernel/cycle.py:1710-1721`
  - `aria-kernel/aria_kernel/human_required.py:795`
  - `aria-kernel/aria_kernel/human_required.py:832-880`
  - `aria-kernel/aria_kernel/self_improvement.py:127`
- Rule: Operator decision 2026-10-18: no human labels; ground truth comes from the evidence-based
  adversarial protocol (bounded rebuttal, evidence-weighing arbiter, 'unverifiable' as a terminal
  outside truth); PLAN-v2 F0.7.

## ARIA-MEDIUM-731

The experiment night re-selects a refuted problem hypothesis every night: plan_night_experiments
picks any OPEN finding without a reproduction and never counts its earlier unmatched observations,
so two whole-service recipes ran 94 times without a match

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F0.6.
- Evidence:
  - `aria-kernel/aria_kernel/experiment_night.py:91-160`
  - `aria-kernel/aria_kernel/experiment_night.py:46`
  - `aria-kernel/aria_kernel/experiment_night.py:201-260`
- Rule: PLAN-v2 §1.3 and F0.6: a measured refutation changes behaviour; after N≈5 unmatched
  observations the hypothesis is skipped and the refutation is recorded on the finding.

## ARIA-LOW-732

memory/learning-events.jsonl has three writers (memory.\_record_learning_event, plus direct appends
in goldset.py and pr_tracking.py) and one reader, the daily report, so no mechanism derives liveness
from the learning journal

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): F1.1.
- Evidence:
  - `aria-kernel/aria_kernel/memory.py:1848-1861`
  - `aria-kernel/aria_kernel/goldset.py:98-104`
  - `aria-kernel/aria_kernel/pr_tracking.py:340-346`
  - `aria-kernel/aria_kernel/reflection.py:1246-1262`
- Rule: PLAN-v2 §2 'Öğrenme günlüğü': memory.record_learning_event is the public single writer with
  a closed vocabulary (one owner, no second writer).

## ARIA-MEDIUM-733

The fitness report has no implementation-quality block and no per-mechanism liveness:
agent_eval.performance_kpis is read only by the CLI and the doctor, and CAPABILITY_SPECS names no
learning mechanism, so a dormant learner looks the same as a working one

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F1.2.
- Evidence:
  - `aria-kernel/aria_kernel/fitness.py:65-89`
  - `aria-kernel/aria_kernel/agent_eval.py:1152`
  - `aria-kernel/aria_kernel/cli.py:4706`
  - `aria-kernel/aria_kernel/doctor.py:676`
  - `aria-kernel/aria_kernel/autonomy_evidence.py:973`
- Rule: PLAN-v2 F1.2 and §2 'Mekanizma karnesi': measure before modifying; a field with no producer
  reads None with a named reason, never a silent 0.

## ARIA-HIGH-734

compare_eval_windows calls a window 'improved' on any positive pass_rate delta with only 5 runs per
30-day window and no significance test, and genesis_superiority calls it without mock_mode, so mock
eval runs count toward a promotion's gain

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-04.
- Plan item(s): F1.7.
- Evidence:
  - `aria-kernel/aria_kernel/agent_eval.py:721`
  - `aria-kernel/aria_kernel/agent_eval.py:724-731`
  - `aria-kernel/aria_kernel/agent_eval.py:790-802`
  - `aria-kernel/aria_kernel/genesis_superiority.py:88-95`
  - `aria-kernel/aria_kernel/judge_calibration.py:252`
- Rule: PLAN-v2 §1.3 and §2 'Kazanç/anlamlılık': gain is a paired test on the same held-out case ids
  (exact McNemar, wilson_lower, an A/A noise floor, alpha and minimum discordant pairs
  pre-registered); mock agent_eval runs are not scored.

## ARIA-MEDIUM-735

The lint-rules adapter's runner declares no repo-local dependencies, so a workspace without the
ESLint plugins its config imports makes the adapter exit 1 and the run is recorded as a tool 'crash'
instead of environment_unavailable

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F2.1.
- Evidence:
  - `tools/aria-adapters/lint-rules.eslint.config.mjs:17-19`
  - `tools/aria-adapters/lint-rules-adapter.tool.json:60-73`
  - `aria-kernel/aria_kernel/tool_registry.py:1087-1109`
  - `aria-kernel/aria_kernel/tool_runner.py:170-183`
  - `aria-kernel/aria_kernel/tool_runner.py:220-222`
  - `package.json:327`
- Rule: An adapter emits findings or fails with a named reason; a missing environment dependency is
  environment_unavailable, never tool guilt (tool_runner.py:171-180, the ARIA-MEDIUM-508 rule).

## ARIA-LOW-736

The workflow-shell-safety adapter models command substitution only as a downloaded script, so a
backtick command inside a double-quoted echo or printf (the R03 class) is invisible to ARIA's
discovery, while a kernel hygiene test owns a scanner for exactly that shape

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): F2.1.
- Evidence:
  - `tools/aria-adapters/workflow-shell-safety-adapter.ts:621-653`
  - `aria-kernel/tests/invariants/v3/test_phase_b1_argv_proven_workflow_hygiene.py:61-70`
  - `aria-kernel/tests/invariants/v3/test_phase_b1_argv_proven_workflow_hygiene.py:224-240`
- Rule: One owner per rule (single center): ARIA's detector reports the class the repository's own
  gate refuses, through the same scanner.

## ARIA-HIGH-737

Consensus promotion accepts any ai_consensus true_positive row instead of is_ground_truth_row and
checks evidence refs as working-tree files instead of at the judged SHA, so 7 of the 13 live
promotions rest on 2-judge consensus that is not ground truth

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-04.
- Plan item(s): F2.3.
- Evidence:
  - `aria-kernel/aria_kernel/finding_promotion.py:159-162`
  - `aria-kernel/aria_kernel/finding_promotion.py:80-95`
  - `aria-kernel/aria_kernel/finding_promotion.py:211`
  - `aria-kernel/aria_kernel/feedback_store.py:228-261`
- Rule: PLAN-v2 §2 'Bulgu kabul çıtası': is_ground_truth_row together with
  evidence_trust.classify_evidence_ref / quote_matches_at at the row's target_sha, fail-closed at
  the promotion seam (unknown = no promotion); the predicate that suppresses a false positive also
  admits a true positive.

## ARIA-LOW-738

The rule_contract_undeclared refusal is restated at four consumers (judge fan-out, promotion,
re-mint, replay) instead of being decided once at intake through rule_contract.resolve_rule_contract

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): F2.4, §2 Kural sözleşmesi.
- Evidence:
  - `aria-kernel/aria_kernel/judge_fanout.py:314`
  - `aria-kernel/aria_kernel/finding_promotion.py:195`
  - `aria-kernel/aria_kernel/judge_remint.py:33`
  - `aria-kernel/aria_kernel/judge_replay.py:96`
  - `aria-kernel/aria_kernel/rule_contract.py:129`
- Rule: PLAN-v2 §2 'Kural sözleşmesi': the contract is resolved once at intake and the four
  consumers read one helper (single owner).

## ARIA-MEDIUM-739

finding_fingerprint hashes the evidence list including line numbers, so suppression, settledness and
promotion state keyed on it treat a moved adapter violation as a new finding, although
finding_subject already owns a location-free identity

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F2.5.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:1552-1568`
  - `aria-kernel/aria_kernel/feedback_store.py:1540`
  - `aria-kernel/aria_kernel/finding_subject.py:96-110`
  - `tools/aria-adapters/lint-rules-adapter.ts:207`
- Rule: PLAN-v2 §2 'Bulgu kimliği': finding_subject (location-free) owns identity; fingerprints are
  written v2-only and v1 rows are read through a reader-side upcaster (ARIA-HIGH-045 rule: a
  position is never identity).

## ARIA-HIGH-740

Adapter precision and the 30-day false-positive counter count raw single-judge votes, which moved
three adapters into CALIBRATE, and CALIBRATE has no automatic exit and is left out of the
calibration report (8 of 15 adapters sit there)

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-04.
- Plan item(s): F2.6.
- Evidence:
  - `aria-kernel/aria_kernel/tool_health.py:645-695`
  - `aria-kernel/aria_kernel/tool_health.py:494-506`
  - `aria-kernel/aria_kernel/promotion.py:158`
  - `aria-kernel/aria_kernel/promotion.py:35-36`
  - `aria-kernel/aria_kernel/autonomy_orchestrator.py:966-972`
- Rule: PLAN-v2 §2 'Precision popülasyonu': one population selector in feedback_store, ground-truth
  rows as the authority population and raw votes for judge scoring only; F2.6: CALIBRATE exits when
  corrected precision has a Wilson lower bound >= precision_min with n >= min_samples.

## ARIA-LOW-741

A delivered change records neither the dispatch provider and model nor per-file churn, so
implementation quality cannot be split by provider or compared with diff size

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): F3.1.
- Evidence:
  - `aria-kernel/aria_kernel/implementation_delivery.py:284-287`
  - `aria-kernel/aria_kernel/change_ledger.py:334`
  - `aria-kernel/aria_kernel/agent_eval.py:858-863`
- Rule: PLAN-v2 F3.1 'Sağlayıcı/model + numstat damgası': measure before modifying; WP-P lets either
  provider write, so every implementation outcome must name its provider and model.

## ARIA-MEDIUM-742

No loop guard refuses re-planning a finding whose change already has an open PR: finding_grounding's
refusals cover quarantine, cool-off, self-loop origin, own change and watchdog only

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F3.1.
- Evidence:
  - `aria-kernel/aria_kernel/finding_grounding.py:112-121`
  - `aria-kernel/aria_kernel/finding_grounding.py:628-695`
  - `aria-kernel/aria_kernel/merge_record.py:233`
- Rule: PLAN-v2 F3.1 'PR açıkken yeniden plan yok': one subject has one change in flight.

## ARIA-LOW-743

The plan round cap has one named owner (AUTONOMY_CYCLE_MAX_ROUNDS = 2) but four literal defaults of
4 or 5 beside it, and evaluate_plan turns reaching the cap with blockers into HUMAN_REQUIRED

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): F3.1.
- Evidence:
  - `aria-kernel/aria_kernel/convergence_drainer.py:117-123`
  - `aria-kernel/aria_kernel/convergence_drainer.py:192`
  - `aria-kernel/aria_kernel/convergence_drainer.py:495`
  - `aria-kernel/aria_kernel/autonomy_orchestrator.py:1064`
  - `aria-kernel/aria_kernel/plan_convergence.py:128`
  - `aria-kernel/aria_kernel/plan_round_controller.py:40`
- Rule: ARIA-HIGH-368's own rule (one constant read by every advancer) and PLAN-v2 F3.1: the cap is
  chosen by a measured, pre-registered criterion and its terminal goes to the arbiter or a revision,
  not HUMAN_REQUIRED.

## ARIA-MEDIUM-744

A finding's recorded red reproduction is never used: the plan validation suite never includes it,
finding_fix_verified has only a CLI producer, and merge closure resolves the finding on detector
silence without re-running the reproduction green

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F3.5, F3.2.
- Evidence:
  - `aria-kernel/aria_kernel/plan_contract.py:151-176`
  - `aria-kernel/aria_kernel/cross_review_bridge.py:667`
  - `aria-kernel/aria_kernel/finding.py:787`
  - `aria-kernel/aria_kernel/finding.py:856`
  - `aria-kernel/aria_kernel/cli.py:5870`
  - `aria-kernel/aria_kernel/finding_closure.py:202-308`
- Rule: PLAN-v2 §2 'Kırmızı→yeşil olgusu' (finding.py:787/:856 own the fact) and F3.5: a fix closes
  a reproduced finding only when the same recipe goes red before and green after.

## ARIA-HIGH-745

change_outcome has two resolvers and no 'reverted' verdict, ignores post-merge CI and reverts, and
only reads ARIA's own validated chains, so ARIA's only merged fix (PR #1906, red after merge) reads
'unknown' while its finding is RESOLVED

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-04.
- Plan item(s): F3.3.
- Evidence:
  - `aria-kernel/aria_kernel/change_outcome.py:18`
  - `aria-kernel/aria_kernel/change_outcome.py:87-90`
  - `aria-kernel/aria_kernel/change_outcome.py:116-121`
  - `aria-kernel/aria_kernel/change_outcome.py:397-400`
  - `aria-kernel/aria_kernel/change_outcome.py:447`
- Rule: PLAN-v2 §2 'Sonuç (tuttu mu)': change_outcome is the one outcome owner, with reality
  resolvers post_merge_ci (nearest-ancestor attribution), reverted, finding_recurrence,
  experiment_rerun_hold and closure_by_any_author, kept apart from Board resolvers by an invariant;
  the merge index lives in merge_record.

## ARIA-MEDIUM-746

'Which merges are ARIA's' has three answers (own_pr_ci by head-branch prefix, self_revert by
auto-merge decisions, merge_record by lineage), so self_revert never covers a person-merged ARIA PR
such as #1906, which went red after merge

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F3.4, §2 Merge indeksi.
- Evidence:
  - `aria-kernel/aria_kernel/self_revert.py:8-11`
  - `aria-kernel/aria_kernel/self_revert.py:642-660`
  - `aria-kernel/aria_kernel/own_pr_ci.py:35`
  - `aria-kernel/aria_kernel/merge_record.py:88`
  - `aria-kernel/aria_kernel/merge_record.py:271-285`
- Rule: PLAN-v2 §2 'Merge indeksi': merge_record (fold_merged_rows, merged_row_is_arias) is the
  single public reader; F3.4: self-revert covers every ARIA merge.

## ARIA-MEDIUM-747

Pre-merge implementation review runs no code: three review lanes (review_runner,
specialist_review_runner, expert_review_gate) decide by reviewer votes, and expert consensus is a
unanimity plus mean-confidence >= 0.80 rule

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F3.12.
- Evidence:
  - `aria-kernel/aria_kernel/expert_review_gate.py:25-27`
  - `aria-kernel/aria_kernel/expert_review_gate.py:60`
  - `aria-kernel/aria_kernel/expert_review_gate.py:202-240`
  - `aria-kernel/aria_kernel/expert_review_gate.py:293`
  - `aria-kernel/aria_kernel/review_runner.py:1`
  - `aria-kernel/aria_kernel/specialist_review_runner.py:1`
- Rule: PLAN-v2 F3.12 and the WP-J protocol: evidence over votes (an executable reproduction ranks
  first) and one review owner.

## ARIA-LOW-748

A plan's architectural_tier claim (1-4) is checked for presence and range only and is never compared
with what the change did, so 'architectural, not a patch' is self-reported

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): F3.11.
- Evidence:
  - `aria-kernel/aria_kernel/plan_contract.py:204-213`
  - `aria-kernel/aria_kernel/apply_engine.py:707-712`
  - `aria-kernel/aria_kernel/fitness.py:65-89`
- Rule: CLAUDE.md Architectural-solution hierarchy (a tier claim must be true) and PLAN-v2 F3.11.

## ARIA-MEDIUM-749

The plan contract asks for no witness test, pre-mortem or change kind, so a converged fix plan names
no test that is red on its defect, and every recorded change chain has rollback_ref null

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F3.8.
- Evidence:
  - `aria-kernel/aria_kernel/plan_contract.py:42`
  - `aria-kernel/aria_kernel/plan_contract.py:217-240`
  - `aria-kernel/aria_kernel/plan_contract.py:294-340`
  - `aria-kernel/aria_kernel/apply_engine.py:726-741`
- Rule: PLAN-v2 F3.8 'Plan v3': a fix plan carries its witness, pre-mortem and change_kind
  (PLAN_CONTRACT_SCHEMA_VERSION 3).

## ARIA-LOW-750

One finding opens two change chains: the experiment night emits change_planned under plan_id
`experiment-night:<finding>` and staging emits another under the plan's own id, and
emit_change_planned dedups only on (plan_id, finding_id, files)

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): §2 Değişiklik zinciri, F3.5.
- Evidence:
  - `aria-kernel/aria_kernel/experiment_night.py:209-216`
  - `aria-kernel/aria_kernel/apply_engine.py:724-741`
  - `aria-kernel/aria_kernel/change_ledger.py:189-200`
- Rule: PLAN-v2 §2 'Değişiklik zinciri': change_ledger keeps one chain per finding.

## ARIA-MEDIUM-751

Mixed-origin text reaches agent prompts without the <untrusted\_\*> boundary: established knowledge
(beliefs, conventions, decision memory, past failed attempts) and self-change proposer prose are
rendered untagged, while only evidence excerpts, plan bodies and pressure context carry the tag

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F4.0.
- Evidence:
  - `aria-kernel/aria_kernel/agent_invocations.py:527-546`
  - `aria-kernel/aria_kernel/agent_invocations.py:560-640`
  - `aria-kernel/aria_kernel/self_change_bridge.py:58-62`
  - `aria-kernel/aria_kernel/cross_review_bridge.py:126-130`
- Rule: PLAN-v2 §2 'Güven sınırı' and F4.0 (WP-T items 1/2/4): every path that mixes text of
  different origin goes through the existing untrusted-tag owners (the agent_invocations pattern,
  untrusted_tree.py, text_safety.py).

## ARIA-MEDIUM-752

Post-merge outcomes never reach the learners: implementer episodes ignore change_outcome, and
pressure-source effectiveness counts a merge only when the orchestrator's own auto-merge landed it,
so every source reads merged = 0 although PR #1906 merged

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F4.1, F3.3.
- Evidence:
  - `aria-kernel/aria_kernel/agent_eval.py:923-995`
  - `aria-kernel/aria_kernel/autonomy_orchestrator.py:2983-2993`
  - `aria-kernel/aria_kernel/mission_scheduler.py:235`
  - `aria-kernel/aria_kernel/knowledge_graph.py:953`
- Rule: PLAN-v2 F4.1 'Sonuç destekli episodlar' and §2 'Merge indeksi': outcomes come from
  change_outcome over merge_record, not from whichever lane did the merge.

## ARIA-MEDIUM-753

Recurring failure modes never become planner obligations: the procedural ledger holds modes that
recur three or more times ('stalled' 13), yet none of the 1,614 live agent requests carries an
observed_plan_failure obligation, and the reason each lesson is dropped is not recorded

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F4.1.
- Evidence:
  - `aria-kernel/aria_kernel/planner_lessons.py:74-92`
  - `aria-kernel/aria_kernel/agent_eval.py:847`
  - `aria-kernel/aria_kernel/agent_eval.py:1099`
  - `aria-kernel/aria_kernel/must_satisfy.py:308-333`
  - `aria-kernel/aria_kernel/convergent_planning_bridge.py:116-117`
- Rule: PLAN-v2 §2 'Ders': agent_eval.recurring_failure_modes + failure_attribution own lessons and
  the threshold does not change; F4.1: each dropped lesson records its drop reason.

## ARIA-MEDIUM-754

Nothing measures whether accepted findings were worth fixing: no producer computes an actionable
rate over promoted findings, and change_outcome scores only ARIA's own validated chains, so none of
the 13 promoted findings has an outcome

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F4.2.
- Evidence:
  - `aria-kernel/aria_kernel/fitness.py:65-89`
  - `aria-kernel/aria_kernel/change_outcome.py:18`
  - `aria-kernel/aria_kernel/role_fitness.py:85-92`
  - `aria-kernel/aria_kernel/readiness.py:45-51`
- Rule: PLAN-v2 F4.2: actionable precision over all promoted findings, resolved through
  change_outcome's reality partition including closure_by_any_author, reported with n >= 30 and a
  Wilson lower bound; detector silence is a weak class.

## ARIA-MEDIUM-755

A convention's identity is its cycle, not its content, it carries no claim text, and the reader
serves superseded rows: one lesson recurs as separate patterns (tenant-config x3) and a verified
convention is served beside the hypothesis it superseded

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F4.4.
- Evidence:
  - `aria-kernel/aria_kernel/cycle_phases/memory.py:63`
  - `aria-kernel/aria_kernel/knowledge_graph.py:100-137`
  - `aria-kernel/aria_kernel/knowledge_graph.py:597`
  - `aria-kernel/aria_kernel/knowledge_graph.py:815-837`
  - `aria-kernel/aria_kernel/agent_invocations.py:262-271`
- Rule: PLAN-v2 §2 'Convention kimliği': knowledge_graph keyed by pattern signature, legacy rows
  folded by a reader-side upcaster, a superseded id is never served.

## ARIA-MEDIUM-756

Memory uncertainties carry no kind and never close: \_record_uncertainty writes status 'open'
without a kind, pressure skips every kindless row, and capability_gap turns repeated reasons into
agent-genesis gaps

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F4.5.
- Evidence:
  - `aria-kernel/aria_kernel/memory.py:1779-1801`
  - `aria-kernel/aria_kernel/pressure.py:662-673`
  - `aria-kernel/aria_kernel/capability_gap.py:561-585`
- Rule: PLAN-v2 §2 'Belirsizlik': memory.\_record_uncertainty stamps a closed kind and a closure;
  capability_gap never routes memory uncertainties into genesis.

## ARIA-MEDIUM-757

Capability gaps are routed twice: learning.\_skill_or_agent_genesis sends every non-blocked gap to
genesis while self_improvement.scan_signals sends the same gaps to self-change missions, and remedy
routing is split across SIGNAL_REMEDIES and ADAPTATION_SIGNAL_KINDS

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F4.7.
- Evidence:
  - `aria-kernel/aria_kernel/learning.py:339-466`
  - `aria-kernel/aria_kernel/self_improvement.py:51-52`
  - `aria-kernel/aria_kernel/self_improvement.py:118-127`
  - `aria-kernel/aria_kernel/self_improvement.py:418-429`
- Rule: PLAN-v2 §2 'Çare tablosu (tek)': SIGNAL_REMEDIES keyed family:kind is the one remedy table;
  capability_gap produces gaps and does not route them.

## ARIA-HIGH-758

Discovery recall has no producer: role_fitness recall is per-adapter retention of that tool's own
gold findings, judge_replay recall is judge recall over gold items, and missed_signals feed neither,
so the stage-2 recall gate and the section-test reverts cannot be measured

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-04.
- Plan item(s): F5.2, F1.3.
- Evidence:
  - `aria-kernel/aria_kernel/role_fitness.py:85-92`
  - `aria-kernel/aria_kernel/role_fitness.py:155-165`
  - `aria-kernel/aria_kernel/judge_replay.py:202-211`
  - `aria-kernel/aria_kernel/goldset.py:353-354`
  - `aria-kernel/aria_kernel/feedback.py:29-50`
- Rule: PLAN-v2 §2 'Keşif recall'u': one subject-keyed block in role_fitness (caught vs
  missed_signal, gold hunk window plus defect class, false-alarm rate on clean control commits),
  which the Board API calls instead of computing its own.

## ARIA-HIGH-759

No adapter found any of the 13 real defects planted by reverting merged fixes in the 2026-10-20
section test, including a backtick command in a workflow echo that workflow-shell-safety read and
kernel .py defects inside agent-harness-security's declared scope

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-04.
- Plan item(s): F5.2, F5.4, F5.5, F5.7, F5.8.
- Evidence:
  - `tools/aria-adapters/agent-harness-security-adapter.tool.json:7-12`
  - `tools/aria-adapters/workflow-shell-safety-adapter.ts:621-653`
- Rule: An autonomous maintenance system surfaces the defects that matter, not only the pattern
  classes its adapters encode; measured blindness is a capability gap, not a tuning issue.

## ARIA-MEDIUM-760

No exam plants mutants in real modules and runs them through discovery: main has no mutant builder,
and the canary design on fix/aria-wp-j hands synthetic findings to the judge panel, which measures
judge sensitivity only

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F5.4.
- Evidence:
  - `aria-kernel/aria_kernel/role_fitness.py:155-165`
  - `aria-kernel/aria_kernel/goldset.py:342-354`
  - `aria-kernel/aria_kernel/judge_calibration.py:252`
- Rule: PLAN-v2 §2 'Sınav korpusu inşası' and F5.4: mutation_canary is the one builder; real-module
  mutants run (a) as unlabelled commits through change review and the adapters and (b) as canary
  rows; secret-seeded in the Board vault; >= 30 per module class; judge bars at the Wilson lower
  bound.

## ARIA-MEDIUM-761

Change review covers only ARIA's own merged PRs: pr_tracking.\_merges reads merge_record's merged
rows, so merges that people and Claude sessions land on main get no change_intelligence review

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): F5.5.
- Evidence:
  - `aria-kernel/aria_kernel/pr_tracking.py:72-84`
  - `aria-kernel/aria_kernel/pr_tracking.py:93-110`
  - `aria-kernel/aria_kernel/cycle.py:1790-1830`
- Rule: PLAN-v2 §2 'Değişiklik incelemesi' and F5.5: \_phase_change_intelligence reviews every
  merge, with a verdict-bearing row or a named budget hold, coverage and hold share reported
  separately.

## ARIA-LOW-762

No history-replay exam exists: nothing builds cases from merged fixes' Closes trailers back to the
commit that introduced the defect, so ARIA's recall on real past defects is never measured

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): F5.7, B2.
- Evidence:
  - `aria-kernel/aria_kernel/plan_origin.py:62-66`
  - `aria-kernel/aria_kernel/judge_replay.py:202-211`
  - `tools/aria-acceptance/harness.py:325-330`
- Rule: PLAN-v2 F5.7: SZZ replay on the Board side in a hermetic tree cut at the introducing commit;
  a case is admitted only if the fix's test is red there and green at its parent (prove_red_first);
  results stratified by source.

## ARIA-LOW-763

No variant hunt exists: a confirmed finding or a merged Closes fix never triggers a search for the
same defect elsewhere in the repository

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): F5.8.
- Evidence:
  - `aria-kernel/aria_kernel/finding_subject.py:96-110`
  - `aria-kernel/aria_kernel/plan_origin.py:62-66`
- Rule: PLAN-v2 F5.8 'Varyant avı'.

## ARIA-LOW-764

Blind spots are measured only as adapter glob coverage feeding capability gaps; no nightly metric
reports which paths and defect classes no discovery mechanism (adapters, change review, variant
hunt) reached

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): F5.9.
- Evidence:
  - `aria-kernel/aria_kernel/observation_coverage.py:200-230`
  - `aria-kernel/aria_kernel/observation_coverage.py:285-300`
  - `aria-kernel/aria_kernel/capability_gap.py:424`
  - `aria-kernel/aria_kernel/fitness.py:65-89`
- Rule: PLAN-v2 F5.9 'Kör nokta metriği' and §2 'Kaçırma sınıfı' (no_coverage is owned by
  observation_coverage).

## ARIA-HIGH-765

ARIA's stop is a file in its own writable store that the kernel itself writes, no merge-path module
checks it, and the merge runner wires no operator-owned variable into its preflight kill switch

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-04.
- Plan item(s): B0, B5, F1.5.
- Evidence:
  - `aria-kernel/aria_kernel/autonomy_orchestrator.py:3038`
  - `aria-kernel/aria_kernel/autonomous_planner_dispatcher.py:105`
  - `aria-kernel/aria_kernel/cycle.py:603`
  - `aria-kernel/aria_kernel/preflight.py:559-563`
  - `.github/workflows/aria-merge-runner.yml:36-39`
  - `.github/workflows/aria-merge-runner.yml:101-143`
- Rule: PLAN-v2 §2 'Durdurma': an operator-owned repository variable vars.ARIA_STOP that ARIA cannot
  write, read by every ARIA workflow (merge-runner and the Board included) and checked by the kernel
  at kernel_change admission and right before the merge call.

## ARIA-MEDIUM-766

No examination identity or held-out store exists outside the ARIA runner's reach: the acceptance
harness imports and runs ARIA's own kernel, adapter rooms run as the kernel's uid, and the nightly
kernel runs unsandboxed on the self-hosted runner

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): B0, B2.
- Evidence:
  - `tools/aria-acceptance/harness.py:45-46`
  - `tools/aria-acceptance/harness.py:325-330`
  - `aria-kernel/aria_kernel/implementation_safety.py:814-816`
  - `.github/workflows/aria-auto-cycle.yml:200`
  - `.github/workflows/aria-auto-cycle.yml:758`
- Rule: PLAN-v2 §1.9, B0 and B2: the Board is outside ARIA's trust domain (separate identity,
  verdicts signed through operator_request_signature, a vault ARIA's uid cannot read, aggregates
  only on aria/state); a hash chain is not an identity.

## ARIA-HIGH-767

Self-change authority is checked only against the paths the proposer declares, AUTHORITY_SURFACES
omits the rollback, freeze, cap and test-collection modules and aria-kernel/tests/, and
tools/aria-acceptance/ is in neither READONLY_PATHS nor CODEOWNERS, so the gates a self-change is
judged by stay writable by the changer

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-04.
- Plan item(s): B1.
- Evidence:
  - `aria-kernel/aria_kernel/self_improvement.py:182-215`
  - `aria-kernel/aria_kernel/self_improvement.py:296-308`
  - `aria-kernel/aria_kernel/self_improvement.py:611`
  - `aria-kernel/aria_kernel/implementation_safety.py:84-151`
  - `.github/CODEOWNERS:23`
  - `.github/CODEOWNERS:36`
- Rule: PLAN-v2 §2 'Türetilmiş yetki kümesi (anayasa)' and B1: one function derives the set
  (AUTHORITY_SURFACES, the Board import closure, rollback and limit modules, test collection,
  trust-boundary renderers) and it is enforced in READONLY_PATHS and the merge perimeter, on the
  realized diff in kernel_change_lane, in CODEOWNERS and by a full-set invariant.

## ARIA-MEDIUM-768

A self-change carries no independent witness of the defect it fixes: on main its only validation is
the generic kernel suite command, and the kernel-change lane on fix/aria-kc-self-improve pins it on
tests the change itself adds

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): B3, F3.2.
- Evidence:
  - `aria-kernel/aria_kernel/self_improvement.py:233`
  - `aria-kernel/aria_kernel/self_improvement.py:577-616`
  - `aria-kernel/aria_kernel/self_change_bridge.py:58-62`
  - `aria-kernel/aria_kernel/self_change_bridge.py:106`
- Rule: PLAN-v2 §1.5 (whoever changes something does not write its gate) and B3: the Board's blind
  witness writer works from missed_signal + miss_class + the Board's own reproduction, in a fresh
  clone with no candidate refs, proven through validation.prove_red_first with an explicit pin
  input.

## ARIA-HIGH-769

Every step of the self-change path ends at a human: each proposal opens a HIGH HUMAN_REQUIRED
adjudication, READONLY_PATHS refuses kernel and adapter writes at mint and at merge, risk policy
puts aria-kernel/\*\* and tools/\*\* in L3 behind an operator policy approval, autonomy_unlock needs
five human L3 approvals, and every revert freezes self-merge until an operator lifts it

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-04.
- Plan item(s): B4, B6, §9-A3.
- Evidence:
  - `aria-kernel/aria_kernel/self_improvement.py:620`
  - `aria-kernel/aria_kernel/implementation_safety.py:2761-2780`
  - `docs/aria/policy/risk-policy.json:7`
  - `docs/aria/policy/risk-policy.json:53-63`
  - `aria-kernel/aria_kernel/risk_policy.py:373`
  - `aria-kernel/aria_kernel/self_revert.py:783-801`
  - `aria-kernel/aria_kernel/self_revert.py:1151`
  - `aria-kernel/aria_kernel/self_merge_freeze.py:1`
  - `aria-kernel/aria_kernel/operator_approval.py:70`
  - `aria-kernel/aria_kernel/autonomy_unlock.py:28`
  - `docs/aria/policy/autonomy-unlock.json:20`
- Rule: Operator decision 2026-10-21: no human approval in self-improvement, the core included; the
  trust anchor is the Independent Examination Board. PLAN-v2 B4: the 8 seams read one root
  (operator_approval.require_operator_act plus a signed board:<verdict_id> for the closed
  BOARD_ADJUDICABLE set).

## ARIA-LOW-770

A self-change cannot target ARIA's adapters because tools/aria-adapters/ is outside
SELF_CHANGE_ALLOWED_PREFIXES, and the trust TRUSTED_PYTHON_SCRIPT_PREFIXES gives
tools/aria-adapters/ rests on that path being READONLY

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): B5.
- Evidence:
  - `aria-kernel/aria_kernel/self_improvement.py:182`
  - `aria-kernel/aria_kernel/implementation_safety.py:182-194`
  - `aria-kernel/aria_kernel/implementation_safety.py:103`
- Rule: PLAN-v2 B5: tools/aria-adapters/ joins the self-change scope only with the trust of
  TRUSTED_PYTHON_SCRIPT_PREFIXES bound to Board-signed merge provenance, and adapter programs run
  only in the adapter room.

## ARIA-MEDIUM-771

The self-improvement scan reads no finding-quality signal: its families cover capability gaps,
funnel stalls, delivery SLO gaps, MCP quarantine, doctor organs, deadlines and adaptations, but not
role_fitness below its floor, a negative convention lift or a drop in missed-signal recall

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): L1.
- Evidence:
  - `aria-kernel/aria_kernel/self_improvement.py:345-348`
  - `aria-kernel/aria_kernel/self_improvement.py:385-475`
  - `aria-kernel/aria_kernel/fitness.py:79-83`
- Rule: PLAN-v2 L1: the quality families join the one remedy table (F4.7) under the existing max_new
  = 3.

## ARIA-MEDIUM-772

The convention-stability genesis entrance can never fire and would bypass the router if it did: it
reads the governance kinds convergence_resolved and pattern_signature_observed, which nothing writes
to governance, and on 'stable' it mints its own skill_genesis HUMAN_REQUIRED

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Plan item(s): L5, F4.7.
- Evidence:
  - `aria-kernel/aria_kernel/cycle_phases/memory.py:438-452`
  - `aria-kernel/aria_kernel/cycle_phases/memory.py:509-530`
  - `aria-kernel/aria_kernel/convergence_outcome.py:293-296`
  - `aria-kernel/aria_kernel/autonomy_orchestrator.py:2385`
- Rule: PLAN-v2 §2 'Çare tablosu (tek)' and L5: one genesis entrance (the learning router with the
  612 seed builder); no new human gate on a self-improvement surface.

## ARIA-LOW-773

Memory archived before ARIA-HIGH-263 (collapsed beliefs and dropped learning events under
tools/archives/) has no reader, so what ARIA learned before the fix is unreachable to every memory
consumer

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Plan item(s): L6.
- Evidence:
  - `aria-kernel/aria_kernel/state_compact.py:20-26`
  - `aria-kernel/aria_kernel/state_manifest.py:612`
- Rule: PLAN-v2 L6 'Arşiv replay'i'; memory is never lost (the ARIA-HIGH-263 rule).

## ARIA-MEDIUM-774

ARIA's infrastructure-policy adapter observes compose runtime guards and the production compose
scope nowhere: missing_runtime_guard covers Kubernetes pods only, and every compose file is judged
alike instead of by service-catalog activeDropletComposeServices

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Raised by: the ARIA-HIGH-012 landing (landing/aria-high-012), as the part of the G017 PR-2 design
  that landing does not do. The nginx include map the landing's first stub also listed is fixed in
  that landing (round-2 review B1) and is not part of this finding.
- Evidence:
  - `tools/aria-adapters/infrastructure-policy-adapter.tool.json` (missing_runtime_guard premise 3:
    'Compose services are not this rule's surface')
  - `tools/gates/infra-policy/runtime-guards.ts` (composeGuards has no caller)
  - `infrastructure/deploy/service-catalog.generated.json` (activeDropletComposeServices, read by
    nothing in the adapter)
- Rule: G017 PR-2 design (wave2/design/G017.md step 4): production scope from service-catalog
  activeDropletComposeServices, and composeGuards with composition through build: -> Dockerfile
  HEALTHCHECK.
- Failure scenario: a droplet compose service loses its healthcheck or mem_limit and ARIA records
  nothing; a dev-only compose service's floating tag is weighed like a production one.

## ARIA-MEDIUM-775

terraform-pins reads any registry module `version` as pinned: a range such as `~> 5.0` or `>= 4`
lets the module change under an unchanged .tf file and ARIA records it clean

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Raised by: the round-2 review of the ARIA-HIGH-012 landing (minor M3), registered by that
  landing's round-3 implementer instead of being deferred without an id.
- Evidence:
  - `tools/gates/infra-policy/terraform-pins.ts:186-191` (registry_versioned whenever a `version`
    attribute exists, whatever it says)
  - `tools/gates/infra-policy/terraform-pins.ts:52` (registry_versioned is pinned)
- Rule: an owner that cannot show a pin reports unpinned or unresolved, never pinned.
- Failure scenario: `version = "~> 5.0"` resolves to 5.9 today and 5.10 after the next
  `terraform init`; the adapter emits no unpinned_terraform_source claim.

## ARIA-LOW-776

The infrastructure-policy adapter keeps second copies of what tools/gates owns: the kustomization
basename, the pod guard vocabulary and a dead 'Kustomization' candidate

- Severity: LOW; owner: Okan-wqm; deadline: 2026-12-21.
- Raised by: the round-2 review of the ARIA-HIGH-012 landing (minor M5), registered by that
  landing's round-3 implementer.
- Evidence:
  - `tools/aria-adapters/infrastructure-policy-adapter.ts:166` (KUSTOMIZATION_BASENAME, a copy of
    `tools/gates/lib/infra/classify.ts:38`)
  - `tools/aria-adapters/infrastructure-policy-adapter.ts:637` (the guard list, a copy of
    PodGuardGap in `tools/gates/infra-policy/runtime-guards.ts:82`)
  - `tools/aria-adapters/infrastructure-policy-adapter.ts:590` ('Kustomization', which
    classifyInfraFile never yields)
  - `tools/aria-adapters/infrastructure-policy-adapter.ts:600` (optional chaining on a key the
    caller got from the same map)
- Rule: one owner per concept (CLAUDE.md single-centre rule).
- Failure scenario: classify.ts learns a new kustomization spelling or runtime-guards.ts a new
  guard, and the adapter keeps the old list.

## ARIA-MEDIUM-777

The infrastructure-policy summary reports clean: true while a rule is unavailable or an owner left
verdicts unresolved

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Raised by: the round-2 review of the ARIA-HIGH-012 landing (minor M6), registered by that
  landing's round-3 implementer.
- Evidence:
  - `tools/aria-adapters/infrastructure-policy-adapter.ts:1049` (clean counts unobserved files,
    refusals and parse failures only)
  - `tools/aria-adapters/infrastructure-policy-adapter.ts:430-443` (unresolved verdicts, not read
    by clean)
  - `tools/aria-adapters/fixtures/infrastructure-policy-adapter/cases/real-repo-baseline.json`
    (requires clean true while the real repo has 6 unresolved verdicts)
- Rule: no silent skip: an unresolved verdict is an observation, never a clean result.
- Failure scenario: `.gitleaks.toml` is unreadable in a snapshot or an nginx include is unseen,
  and a consumer that reads only `summary.clean` treats the scan as complete.

## ARIA-MEDIUM-778

ARIA's literal_secret rule reads only compose and Kubernetes container env: a literal in a
Kubernetes Secret's stringData or data under a gitleaks-allowlisted path is never judged

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Raised by: the round-2 review of the ARIA-HIGH-012 landing (minor M7, no live case on that
  review's tree), registered by that landing's round-3 implementer.
- Evidence:
  - `tools/aria-adapters/infrastructure-policy-adapter.ts:736` and `:764` (compose and container
    env entries, the only ones collected)
  - `tools/aria-adapters/infrastructure-policy-adapter.ts:991` (secretsHiddenByPathAllowlist
    judges only those entries)
- Rule: the literal_secret premise covers every literal the gitleaks path allowlist hides.
- Failure scenario: a Secret with a literal `stringData` value is committed under an allowlisted
  path; gitleaks skips it by path and ARIA records nothing.

## CONTRACT-MEDIUM-013

TelemetryCapacityEntitlementChangedEvent does not extend BaseEvent, and billing-service spreads it
over createBaseEvent's result, so the entitlement's own `version` overwrites the event schema
version on the wire

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-3-R2 (the emit-has-interface invariant folded onto the one definition rule).
- Evidence:
  - `libs/event-contracts/src/billing/telemetry-capacity.ts:87`
  - `apps/billing-service/src/billing/services/telemetry-capacity.service.ts:206`
- Rule: CLAUDE.md Event Contract Rules: a new event's interface extends BaseEvent; event objects
  conform exactly to @platform/event-contracts interfaces. Exempted by id in
  `tests/invariants/event-contract-emit-has-interface.spec.ts` KNOWN_EXEMPT until closed.

## CONTRACT-MEDIUM-014

Two producer sites build their event type at run time, so no contract can be checked for them: the
audit-log interceptor emits `audit.<action>` events (with a nested metadata bag) that no
event-contracts interface defines, and the security event service reads its type from a
Record<SecurityEventType, string>

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-3-R2 (scanEventProducers reports both as unresolved).
- Evidence:
  - `libs/backend-common/src/audit/audit-log.interceptor.ts:285`
  - `libs/backend-common/src/security/security-event.service.ts:168`
  - `libs/backend-common/src/security/security-event.service.ts:209`
- Rule: CLAUDE.md Event Contract Rules and ADR-006 (flat events). Listed by id in the
  emit-has-interface invariant's KNOWN_UNRESOLVED until closed.

## PLAT-MEDIUM-932

No application constructs NatsMigrationEventSink (MigrationRunnerModule defaults to a no-op sink
and no service passes one), so SchemaMigrationStarted/Applied/Failed/Skipped are never published
while observability-service subscribes `events.platform.schema-migration.>`

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-3-R2 (scanEventProducers reports the four sites as unattributed).
- Evidence:
  - `libs/backend-common/src/database/migration-runner/migration-runner.module.ts:187-197`
  - `libs/backend-common/src/database/nats-migration-event-sink.ts:121`
  - `apps/observability-service/src/migration-audit/consumers/schema-migration-events.consumer.ts:63`
- Rule: a consumed event has a producer; dead publisher code is wired or deleted. Listed by id in
  the emit-has-interface invariant's KNOWN_UNATTRIBUTED until closed.

## ARIA-MEDIUM-789

The code-fact producer scan attributes no application to a library class constructed only inside a
library function (ErrorCaptureInterceptor, built in createServiceApp behind bootstrapService), so
the bridge lists no producer of ServiceErrorCaptured although every service emits it

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-13.
- Raised by: SE-3 review round 1 (single-owner reviewer, non-blocking observation).
- Evidence:
  - `tools/gates/event-consumer-index.ts:707-752`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:872`
  - `libs/backend-common/src/observability/error-capture.interceptor.ts:194`
- Rule: service-expertise PLAN §3.1/§3.2: events_produced comes from scanEventProducers and a missing
  result is never silent; SE-4 ranks impacted services on these facts. Listed by id in the
  emit-has-interface invariant's KNOWN_UNATTRIBUTED until closed.

## CONTRACT-MEDIUM-015

The e2e NATS invariant keeps a second reader of "who produces event T": extractPublishedEventTypes
regex-scans each app's sources for `createBaseEvent('X'` and `eventType: 'X'` and feeds PUBLISH
COVERAGE, and it disagrees with scanEventProducers on 408 (app, type) pairs

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-13 (before SE-4 merges).
- Raised by: SE-3-R2 appellate, root R3 (ssot SSOT-R2-B1, evidence E3).
- Evidence:
  - `e2e/tests/integration/nats-invariants.spec.ts:320-333`
  - `e2e/tests/integration/nats-invariants.spec.ts:882-921`
  - `tools/gates/event-consumer-index.ts:1100-1111`
- Rule: one owner per concept (service-expertise PLAN §2, SE-3). Close: after ARIA-MEDIUM-792,
  publish coverage reads `scanEventProducers(REPO_ROOT).entries` and the regex is deleted. Listed by
  id in the single-owner pins of `tools/gates/event-consumer-index.spec.ts` until closed.

## ARIA-MEDIUM-792

scanEventProducers attributes a library construction site whose event type folds to a union to
every wiring app for every member: each of the 11 apps that wire the tenant-erasure executor is
listed as producing all 36 per-service erasure outcome types (about 363 false produced facts and
edges SE-4 would rank on)

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-13 (before SE-4 consumes producers).
- Raised by: SE-3 review round 1 (non-blocking), accepted as part of root R3 by the SE-3-R2
  appellate.
- Evidence:
  - `libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-executor.ts:280`
  - `libs/event-contracts/src/tenant-erasure-targets.ts:113`
  - `infrastructure/nats/services.yaml:454` (ai_service holds only its own AiService\* outcome grants)
  - `tools/gates/event-consumer-index.ts:1055-1094`
- Rule: service-expertise PLAN §3.1/§3.2: a produced fact or edge the code does not support is a
  wrong fact. Close: a site folding through `tenantErasureOutcomeEventType(service, outcome)` is
  attributed only to the wiring application's own outcome types, with a two-app fixture.

## ARIA-MEDIUM-793

The plan-coverage witness keeps a second reader of "where event T is defined": extractEventTypes
reads `eventType` literals of touched contract files by regex, so a contract diff gets different
event-consumer nodes from the witness than from the one definition rule eventDefinitionsIn

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-13.
- Raised by: SE-3-R2 appellate, root R3 (ssot SSOT-R2-B2).
- Evidence:
  - `tools/gates/plan-coverage-witness.ts:189`
  - `tools/gates/plan-coverage-witness.ts:299-309`
  - `tools/gates/event-consumer-index.ts:1360-1375`
- Rule: one owner per concept. Not folded in SE-3-R2: the fold would drop the witness's
  event-consumer nodes for a diff that touches only a schema catalog (89 types the witness reads and
  the rule does not); service-expertise PLAN §2 "Service impact closure" (SE-4) removes the
  witness's event-consumer computation. Close with SE-4.

## CONTRACT-MEDIUM-016

Two invariant specs read event definitions with their own regex instead of eventDefinitionsIn: the
PII crypto-shred invariant locates the interface defining each listed type by an interpolated
`eventType` regex and slices its block by text, and the feeding delivery invariant captures feeding
event types from farm-events.ts

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-3-R2 appellate, root R3 (item d) and the widened single-owner pin.
- Evidence:
  - `tests/invariants/pii-events-mandatory-crypto-shred.spec.ts:123-141`
  - `tests/invariants/feeding-event-delivery-semantics.spec.ts:72-76`
- Rule: one owner per concept. Close: both read `scanEventDefinitions` (the interface declaration
  exposed so the PII invariant checks `cryptoShredKeyId` through the checker); the regexes go.

## ARIA-MEDIUM-794

recursive_impact keeps a Python reader of "where event T is defined" (`_EVENT_INTERFACE_RE`:
`export interface XEvent extends BaseEvent`, by name) beside the one definition rule; its fold is the
F0.9b tombstone of the module (service-expertise PLAN §2 row 1.3)

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-27.
- Raised by: SE-3-R2 appellate, root R3 (item e).
- Evidence:
  - `aria-kernel/aria_kernel/recursive_impact.py:302-304`
- Rule: one owner per concept (PLAN-v2 F0.9b ownership atlas). Close with the F0.9b tombstone.

## ARIA-HIGH-797

The dataflow watchdog's container_state_truth and tenant_reality_parity probes have never measured
anything. They run docker from the runner account, which by design cannot open docker.sock and
cannot gain privilege.

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-06.
- Plan item(s): RW-2 (runtime watch).
- Evidence:
  - `tools/watchdog/probe-runner.mjs:93` (`docker ps -q` run by the runner account; origin/main
    ddf6d5723)
  - `tools/watchdog/probe-runner.mjs:147-151` (`docker exec aqua-postgres psql` run by the runner
    account)
  - `scripts/aria/runner-habitat/systemd/actions-runner.identity.conf` (`SupplementaryGroups=`,
    `NoNewPrivileges=yes`: no docker group, and sudo is inert for every job)
  - Every run from 31069638350 (2026-08-06, the first) through 39963926798 (2026-10-23) reports
    `permission denied ... docker.sock` for both probes.
- Rule: a watchdog probe measures what it names. The runner account never gets docker access or a
  privilege gain (ADR-0023).
- Fix (RW-2): a root-owned probe with fixed arguments, `infrastructure/scripts/aqua-dataflow-probe.sh`.
  It refuses every argument and opens every psql session read-only. It is reached through the
  socket-activated units in `infrastructure/dataflow-probe/` and read by
  `tools/watchdog/privileged-evidence.mjs`. A sudoers rule cannot work: `NoNewPrivileges=yes` makes
  sudo inert for the job. The finding closes once the program lead installs the probe from the
  runbook (`docs/runbooks/monitoring/dataflow-integrity.md`) and one dispatched run shows both
  probes measured. ARIA-HIGH-798 covers why the gap went unseen for ten weeks.

## ARIA-HIGH-798

The dataflow watchdog's results reach no one. A probe-error exits 1, and the lane neither fails nor
reports on exit 1. The probe*\* textfile is written to RUNNER_TEMP and only uploaded as an artifact,
because the textfile directory is root:root 0755. So every probe*\* rule in
60-dataflow-integrity.yml has no series and cannot fire.

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-06.
- Raised by: the RW-2 implementer, while verifying RW-2.
- Evidence:
  - `.github/workflows/dataflow-integrity-watchdog.yml:94` and `:123` (`--textfile
"$RUNNER_TEMP/aqua_probes.prom"`)
  - `.github/workflows/dataflow-integrity-watchdog.yml:126-135` (the textfile is only uploaded as
    an artifact)
  - `.github/workflows/dataflow-integrity-watchdog.yml:146-157` (only exit 3 fails the run; a
    probe that measured nothing passes)
  - `docker-compose.droplet.yml:2205-2206` (node-exporter reads `/var/lib/node_exporter/textfile`)
  - `infrastructure/monitoring/droplet/rules/60-dataflow-integrity.yml:165-204`
    (TenantActiveWithoutPhysicalSchema, TenantProvisioningNeverCompleted, TenantRealityProbeStale)
  - On 2026-10-23 the droplet's textfile directory held only `aqua_worktree_gc.prom`.
- Rule: a probe that cannot measure fails visibly, and an alert rule reads a series that is
  published on the host it scrapes. A rule that can never fire is a defect.
- Failure scenario: the privileged probe measures an ACTIVE tenant with no usable schema, and no
  alert fires, because Prometheus never sees `probe_finding_count`. This is the channel that let
  ARIA-HIGH-797 run unseen from 2026-08-06.

## ARIA-MEDIUM-800

Container truth for the 2026-08-03 "ps lies" incident class has two owners, and the one meant to be
authoritative is not installed on the droplet.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-13.
- Plan item(s): RW-2 (runtime watch), raised by its single-owner review and kept by the appellate as
  dissent: the duplicate predates RW-2, which moves the existing measurement unchanged.
- Evidence:
  - `infrastructure/scripts/aqua-dataflow-probe.sh:64-74` (State.Running per container, measured by
    root for the watchdog lane)
  - `tools/watchdog/probe-runner.mjs:118-128` (the container_state_truth probe id the rules read)
  - `tools/supervisor/runtime-supervisor.ts:105-125` (the supervisor's own container judgement)
  - `infrastructure/supervisor/aqua-supervisor.service:6` ("container truth + host pressure")
  - `infrastructure/monitoring/droplet/rules/60-dataflow-integrity.yml:215-236` (rules over both)
- Rule: one owner per concept; an alert source that is not installed is a decorative rule.
- Close when exactly one owner judges container truth for this class (the supervisor installed and
  read through its published verdict with a freshness check, or its container judgement retired in
  favour of the root probe), an invariant names that owner, and the alert rules read only it.

## ARIA-MEDIUM-801

The planner seats' target agents have three production owners: `plan_round_controller.DEFAULT_PLANNER_AGENTS`,
`cross_review_bridge` (`CROSS_REVIEW_ROLE`, `PRIMARY_REVISION_ROLE`) and
`convergent_planning_bridge.PLANNER_ROLES` each spell the role-to-agent pairs for primary_plan,
challenger_plan and cross_review. If a planner agent is renamed, one mint path changes and the
others do not.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-13.
- Raised by: WPJ-RED appellate, carried forward from the round-1 ssot dissent (dissent item 2).
  Registered by WPJ-FAILOPEN before PR #2073 merges.
- Evidence:
  - `aria-kernel/aria_kernel/plan_round_controller.py:28-32`
  - `aria-kernel/aria_kernel/cross_review_bridge.py:78-82`
  - `aria-kernel/aria_kernel/convergent_planning_bridge.py:28-31`
- Rule: one owner per concept (PLAN-v2 F0.9b ownership atlas). Close: one table maps a planning role
  to its target agent. Both bridges read it, and a pin asserts that no second literal pair exists.
  `agent_surface.py:218` already cites `DEFAULT_PLANNER_AGENTS["cross_review"]` as the reference.

## ARIA-MEDIUM-802

The `(run_id, finding_id, judgment_group_id)` join key has four copies:
`outcome_truth._outcome_key` (with an inline tuple beside it), `feedback_store._judgment_key`,
`judge_calibration._group_key` and `label_queue._key`. `agent_surface` also lists the judgment
seats twice, once as `JUDGE_ROLES` and once as the keys of `EXPERT_METHODS`, and no pin checks that
the two sets are equal.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-13.
- Raised by: WPJ-RED appellate, non-blocking ssot dissent (dissent item 3). The `outcome_truth` copy
  came with WP-J `05d99ba06`. Registered by WPJ-FAILOPEN before PR #2073 merges.
- Evidence:
  - `aria-kernel/aria_kernel/outcome_truth.py:68-73`
  - `aria-kernel/aria_kernel/outcome_truth.py:179`
  - `aria-kernel/aria_kernel/feedback_store.py:466-472`
  - `aria-kernel/aria_kernel/judge_calibration.py:144-149`
  - `aria-kernel/aria_kernel/label_queue.py:73-74`
  - `aria-kernel/aria_kernel/agent_surface.py:128-141`
  - `aria-kernel/aria_kernel/agent_surface.py:159-171`
- Rule: one owner per concept. Close: the other three readers call `feedback_store._judgment_key`,
  whose docstring already calls it "the identity every judgment lane already keys on".
  `JUDGE_ROLES` derives from `EXPERT_METHODS`, or a pin asserts that the two sets are equal. Today
  `tests/test_panel_seats.py` checks only that the four new seats are members of both.

## ARIA-HIGH-805

`judge_fanout._existing_judge_dispatches` and `_judged_pairs` wrap their ledger reads in
`except Exception` and return an empty set. An unreadable `agent_invocation_requests` ledger or
feedback store then reads as "nothing minted" or "nothing judged", and the nightly fan-out re-mints
judges for groups and findings that are already dispatched or answered (fail-open, the
ARIA-HIGH-788 class).

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-13.
- Raised by: WPJ-FAILOPEN appellate round 2, carry-forward item 1 (repeats appellate-r1 item 1;
  security probe P9 found no registry row). Registered before PR #2073 merges. Both readers predate
  WP-J and are on main.
- Evidence:
  - `aria-kernel/aria_kernel/judge_fanout.py:203-216`
  - `aria-kernel/aria_kernel/judge_fanout.py:219-247`
  - `aria-kernel/aria_kernel/ledger.py:94-109`
- Rule: fail closed on an unreadable ledger. Close: both readers catch only `ledger_read_faults()`
  (or a declared reader-fault set built from it) and refuse the mint with a named `GovernanceError`
  that the cycle records as a blocked step, as `_rebuttal_already_minted` (`:1194-1218`) already
  does. A mutation test kills the `except Exception` mutant of each.

## ARIA-MEDIUM-807

`request_admission._measure` holds a second definition of an unreadable cooldown ledger: it catches
`(GovernanceError, OSError, ValueError)` around `provider_outage.cooled_providers`. That tuple
disagrees with `provider_cooldown.cooldown_reader_faults()`. It absorbs every `ValueError`, reader
defects included, and lets `LedgerIntegrityError` and `LedgerReadLimitError` (both `RuntimeError`)
escape.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-13.
- Raised by: WPJ-FAILOPEN appellate round 2, carry-forward item 2 (repeats appellate-r1 item 2,
  "fold or file"; arch probe p4). Registered before PR #2073 merges.
- Evidence:
  - `aria-kernel/aria_kernel/request_admission.py:324-327`
  - `aria-kernel/aria_kernel/provider_cooldown.py:339-352`
  - `aria-kernel/aria_kernel/ledger.py:84-89`
  - `aria-kernel/aria_kernel/tool_registry.py:124`
- Rule: one owner per concept. Close: the `cooled_providers` arm catches `cooldown_reader_faults()`.
  A test drives a `LedgerIntegrityError` and a plain `ValueError` through it and pins that the first
  records `cooldown_fault` and the second propagates. The capacity arm (`:321`) reads a different
  ledger and is judged on its own declared fault set in the same fix.

## ARIA-MEDIUM-809

The judge rebuttal round's one-per-seat bound matches the untrusted substring
`REBUTTAL_MARKER in suggested_prompt`. The dissenter's own first-round envelope embeds the adapter
finding's `message` verbatim, so a finding message that contains "REBUTTAL ROUND 1" marks the seat
as already rebutted and suppresses its one rebuttal.

- Severity: MEDIUM (security); owner: Okan-wqm; deadline: 2026-11-13.
- Raised by: WPJ-FAILOPEN appellate round 2, carry-forward item 3 (security probe P4). It comes from
  WP-J commit `194d7faf3`, which ships in #2073. Registered before PR #2073 merges.
- Evidence:
  - `aria-kernel/aria_kernel/judge_fanout.py:1123`
  - `aria-kernel/aria_kernel/judge_fanout.py:1213`
  - `aria-kernel/aria_kernel/judge_fanout.py:121`
  - `aria-kernel/aria_kernel/judge_fanout.py:945`
- It fails closed (a false `rebuttal_already_minted` skip, never a second rebuttal), so it is not
  the ARIA-HIGH-788 class. The harm: an adapter-controlled string can deny a dissenter its rebuttal.
  Judge rationales are also embedded in the arbiter and anchor prompts (`:697`, `:945`); those match
  only when the arbiter seat is the dissenting agent.
- Rule: untrusted text is data, never a control signal. Close: the rebuttal envelope carries a
  structured marker field (or the check is an exact first-line match of the kernel-rendered prompt).
  A test mints a first-round envelope whose message contains the marker and pins that the rebuttal is
  still minted.

## ARIA-MEDIUM-811

A non-UTF-8 byte in a hash-chained ledger raises `UnicodeDecodeError` from the ledger primitives'
`read_text(encoding="utf-8")` calls. `UnicodeDecodeError` is outside `ledger_read_faults()`, so a
reader that fails closed on store faults aborts the cycle with an undeclared exception instead.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-13.
- Raised by: WPJ-FAILOPEN appellate round 2, carry-forward item 4. Registered before PR #2073
  merges. Reproduced at `fd5fc221e`: a file with one valid row and one `0xFF 0xFE` line makes both
  `load_jsonl_verified` and `read_jsonl` raise `UnicodeDecodeError`, which
  `except ledger_read_faults()` does not catch. `_verify_file_or_raise` maps only `OSError`
  (`:2208`).
- Evidence:
  - `aria-kernel/aria_kernel/ledger.py:934`
  - `aria-kernel/aria_kernel/ledger.py:952`
  - `aria-kernel/aria_kernel/ledger.py:2200-2214`
  - `aria-kernel/aria_kernel/ledger.py:94-109`
- It fails closed (the cycle aborts). Rule: `ledger_read_faults()` is the closed set of store faults.
  Close (owner fix in the primitive, not in callers): `load_jsonl_verified` and the other decode
  sites map `UnicodeDecodeError` to `LedgerIntegrityError` (reason_kind=encoding, with the byte
  offset). A test pins that a non-UTF-8 byte is caught by `ledger_read_faults()` through
  `load_jsonl_verified` and `load_segments`.
- Citation note for ARIA-MEDIUM-802: its evidence cites
  `aria-kernel/aria_kernel/outcome_truth.py:179`, but at `fd5fc221e` the inline join-key tuple is at
  `:180`. The registry CLI has no evidence-amend subcommand for an OPEN row, so the row is not
  edited; the note is carried in the notes of ARIA-HIGH-805, ARIA-MEDIUM-807, ARIA-MEDIUM-809 and
  ARIA-MEDIUM-811.

## ARIA-MEDIUM-791

Three live path -> service attributions outside impact_graph.project_for_path remain until the
F0.9b tombstones: recursive_impact.\_project_for_path, impact.\_affected_projects_hint and
security.assess.\_asset_of each map a path to a project by a layout convention of their own, so
their names can disagree with the one service key

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-18.
- Raised by: SE-1 round 2 (review-r1 BLOCKER-2). The structural single-owner invariant names exactly
  these three in its F0.9b allowance; the five other live second owners it found are folded into
  the owner in that round.
- Plan item(s): F0.9b.
- Evidence:
  - `aria-kernel/aria_kernel/recursive_impact.py:69`
  - `aria-kernel/aria_kernel/impact.py:117-129`
  - `aria-kernel/aria_kernel/security/assess.py:43-48`
  - `aria-kernel/tests/invariants/test_service_key_single_owner.py:72-76`
- Rule: service-expertise PLAN.md §2 row 'Path -> service/project key' item 3 and SO-17:
  recursive_impact, impact.plan_impact and security/profile.py \_detect_services are tombstoned in
  PLAN-v2 F0.9b; \_asset_of is the per-path twin of \_detect_services and goes with it.
- Failure scenario: security assessment files a finding on `apps/<dir>` as `service:<dir>` while
  the finding dimension names the same project by its project.json name, so the two never join.

## ARIA-HIGH-795

ARIA's production metric detectors never ran (watchdog_pull.observability_base_url null), and the
one puller would send the platform's shared INTERNAL_API_KEY to whatever host the policy names, with
no named hold when the source is unread and runtime candidates rejected as one-evidence findings

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-06.
- Plan item(s): RW-1 (SEQUENCE.md "Runtime watch"), registered by its implementer.
- Evidence (at befe16159):
  - `aria-kernel/aria_kernel/genesis_policy.py:548` (observability_base_url None by default) and
    `:551` (api_key_env names the runner's copy of the shared key)
  - `aria-kernel/aria_kernel/aria_watchdog.py:110-112` (x-internal-api-key header to the
    policy-named host)
  - `aria-kernel/aria_kernel/aria_watchdog.py:740-751` (skips land only in the sweep payload) and
    `aria-kernel/aria_kernel/cycle.py:2952-2961` (the digest copies candidates/emitted/suppressed)
  - `aria-kernel/aria_kernel/aria_watchdog.py:575-596` (runtime candidates emitted as one-evidence
    operational_anomaly, rejected and counted suppressed)
  - `scripts/aria/provision_runner.sh:226` (the runner `.env` is required to hold
    ARIA_OBSERVABILITY_API_KEY)
- Rule: RW-1 decisions: no shared internal API key for ARIA; a read-only loopback source read by
  the ONE puller; a missing or unreachable source is a named hold, never silence; runtime claims go
  through the existing proof gate.
- Failure scenario: the watchdog_sweep phase runs every night and reports nothing about production;
  an operator who sets the URL to the observability-service hands ARIA's runner the platform's
  internal key, and a 5xx storm still becomes no finding and no lead.

## ARIA-MEDIUM-796

The runtime watchdog's security-critical detector can never fire: security_events_total carries
only a type label (no severity), and Prometheus's observability-service scrape is refused 401
because that /metrics is INTERNAL_API_KEY-gated

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-06.
- Raised by: the RW-1 implementer (read-only queries on the droplet Prometheus, 2026-10-23:
  `up{app="observability-service"}` = 0 with lastError "server returned HTTP status 401
  Unauthorized"; `count(security_events_total)` = 0).
- Evidence:
  - `apps/observability-service/src/security-events/security-metrics.service.ts:35` (labelNames
    `['type']`, no severity)
  - `aria-kernel/aria_kernel/aria_watchdog.py:343` (the detector requires `severity=critical`)
  - `apps/observability-service/src/prometheus/prometheus.controller.ts:8-10` (/metrics behind the
    global InternalApiGuard)
  - `infrastructure/monitoring/droplet/file_sd/aqua-services.json:134` (the target Prometheus
    scrapes) and `docker-compose.droplet.yml:2152` (a comment that says the scrape is not enabled)
- Rule: a detector that names a signal the source never carries is a silent dead eye; every runtime
  detector reads a series the droplet Prometheus holds.
- Failure scenario: an auth-bypass storm is counted by the observability-service and never reaches
  Prometheus, so the watchdog's security detector reports nothing. Not fixed in RW-1: it needs the
  observability-service metrics surface (a public metrics-only endpoint like the other backends got
  in OBS-HIGH-001, or a scrape credential held by Prometheus, never ARIA) and a severity source for
  security event types.

## ARIA-MEDIUM-832

The receipt leg of the seat law has two owners: seat_receipts is the named owner of the 'model or
method present' rule, but generate_ai_consensus keeps an inline copy of the same predicate for the
anchor-grade observer_identity_missing refusal, so the two can drift apart

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.8 review (lens ssot), registered by the F0.8 findings clerk on 2026-10-24;
  non-blocking at merge.
- Plan item(s): F0.8.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:362-383` (seat_receipts, the named owner of the
    receipt predicate)
  - `aria-kernel/aria_kernel/feedback_store.py:1406-1412` (inline copy:
    str(row.get('model')).strip() or str(row.get('method')).strip())
- Rule: PLAN-v2 F0.8 / diversity-law row: one seat function; every leg (receipt, method stamp,
  evidence) is a leg of it, never restated beside it. One owner per concept.
- Failure scenario: A later change to what counts as a receipt (a new leg, a stricter model check)
  lands in seat_receipts only; the observer_identity_missing refusal keeps the old predicate, so a
  panel is refused as identity-missing that the seat law would count, or the reverse.
- Close condition: the observer_identity_missing refusal in generate_ai_consensus asks the receipt
  predicate seat_receipts owns (or a predicate seat_receipts is built on) instead of restating
  'model or method'; a test pins that the refusal and seat_receipts agree on rows of every shape
  (model only, method only, both, neither, blank judge_id).

## ARIA-MEDIUM-833

Under calibration_gate=enforce, two calibrated, distinct judges whose rows name neither a model nor
a method used to close and now escalate as confidence_uncalibrated (the label queue's reason, capped
per cycle) although both are calibrated; the cause is the missing receipt, which
observer_identity_missing names only for groups of 3 or more

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.8 review (lenses ssot and arch), registered by the F0.8 findings clerk on
  2026-10-24; non-blocking at merge.
- Plan item(s): F0.8.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:1347-1348` (the enforce quorum counts seats by
    seat_receipts and escalates confidence_uncalibrated)
  - `aria-kernel/aria_kernel/feedback_store.py:1406-1416` (observer_identity_missing applies only to
    closing groups of ANCHOR_MIN_JUDGE_COUNT or more)
  - `aria-kernel/aria_kernel/human_required.py:828-833` (the label queue reads
    confidence_uncalibrated first; the sweep caps it per cycle)
  - `tools/aria-poc/ci_executor.py:3062-3065` (agent_dispatch_model is removed when the route names
    no model, so a row can reach this state)
- Rule: An escalation must name its real cause: a reason that points the item at the wrong queue
  spends the labelling budget on a receipt defect (PLAN-v2 F0.8 behaviour change must keep each
  refusal under its own name).
- Failure scenario: calibration_gate=enforce is switched on; a calibrated pair agrees on a finding
  but both rows lack model and method. The group escalates as confidence_uncalibrated: the label
  queue is told to get the judges labelled, they already are, the item is capped out of the sweep,
  and the missing receipt that blocks it is never named.
- Close condition: the enforce quorum names the missing-receipt case observer_identity_missing (or a
  sibling reason mapped in human_required) and not confidence_uncalibrated; a test pins calibrated
  pair + enforce + no model/no method -> that reason, and the item does not use up
  max_uncalibrated_escalations_per_cycle.

## ARIA-MEDIUM-834

Second diversity counts survive the F0.8 landing and test_one_diversity_rule cannot see them:
distinct_observer_models has no production caller, a comparison on a helper call
(distinct_observer_models, len(seat_receipts), provider_span_of) is not flagged, and seat counts by
dict key (len(rows), len(closing)) and verify_panel_diversity sit outside its definition

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.8 review (lenses ssot and arch), registered by the F0.8 findings clerk on
  2026-10-24; non-blocking at merge.
- Plan item(s): F0.8.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:409-418` (distinct_observer_models: a len over a set
    of models, no production caller)
  - `aria-kernel/tests/invariants/test_one_diversity_rule.py:72-118` (\_offenders flags only an
    inline len(set over judge_id/model/method) or an observation_span value)
  - `aria-kernel/tests/invariants/test_one_diversity_rule.py:19-31` (the definition of a diversity
    rule)
  - `aria-kernel/aria_kernel/feedback_store.py:1282` (len(rows) < 2 counts judge rows by dict key,
    without the receipt leg)
  - `aria-kernel/aria_kernel/feedback_store.py:1433` (len(closing) >= ANCHOR_MIN_JUDGE_COUNT in the
    evidence gate)
  - `aria-kernel/aria_kernel/feedback_store.py:1451-1454` (len(closing) gate before
    verify_panel_diversity)
  - `aria-kernel/aria_kernel/independence_check.py:609` (verify_panel_diversity, the answer-echo
    diversity gate)
- Rule: PLAN-v2 F0.8 / diversity-law row: no second diversity rule exists in aria_kernel; the
  detectable tier must see every comparison on a diversity count, not only the inline shapes it was
  written against.
- Failure scenario: A new consumer writes 'distinct_observer_models(row) >= 2' or
  'len(seat_receipts(rows)) >= 2' as its gate; the invariant stays green and the 'different model >=
  2' rule is back beside the seat law, deciding the corner cases its own way.
- Close condition: the invariant fails on a probe module comparing a helper count
  (distinct_observer_models, len(seat_receipts(...)), provider_span_of) and on a dict-key seat
  count; distinct_observer_models is deleted or pinned recorded-only; every remaining
  len(rows)/len(closing) count is routed to the seat function or named in the invariant as an
  allowed descriptor; the invariant docstring states by name that verify_panel_diversity is a
  different property (answer echo) or it is brought under the law.

## ARIA-LOW-835

ANCHOR_MIN_DISTINCT_MODELS = 2 survives in feedback_store with no kernel consumer, and
test_glm_model_admission still asserts a distinct-model floor with it: a leftover of the retired
'different model >= 2' anchor rule that reads as live policy

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.8 review (lens ssot), registered by the F0.8 findings clerk on 2026-10-24;
  non-blocking at merge.
- Plan item(s): F0.8.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:202` (the constant, no consumer in aria_kernel)
  - `aria-kernel/tests/test_glm_model_admission.py:150` (assertGreaterEqual(len(models),
    ANCHOR_MIN_DISTINCT_MODELS))
  - `tools/aria-poc/ci_executor.py:3055` (a comment that cites it as the anchor guarantee)
- Rule: PLAN-v2 F0.8 / diversity-law row: the 'different model >= 2' rule is retired in favour of
  the seat law; a constant that outlives it is a second diversity rule waiting for a consumer. One
  owner per concept.
- Failure scenario: A reader or a new consumer takes the constant as the live anchor policy and
  gates on two distinct models, which on one provider can never be met and holds every verdict.
- Close condition: the constant is deleted; the fleet test states its own property (the routine
  judge pair runs distinct models) with a floor named in the test; the comments in
  ci_executor.py:3055, test_jj1_anchor_consensus.py:261, test_jj3_belief_panel.py:61 and
  test_method_diversity_anchor.py:4 stop citing it; the ban in
  test_wpj_landing_named_resolutions.py:553 keeps barring the name from is_ground_truth_row.

## ARIA-LOW-836

No constant owns the downgrade-reason vocabulary of effective_calibration_gate: the producer writes
its reasons as inline literals (fewer_than_two_calibrated_seats now,
fewer_than_two_calibrated_judges_of_one_span at base) and a doctor test fixture writes a third
spelling, fewer_than_two_calibrated_judges_of_distinct_models

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.8 review (lens ssot), registered by the F0.8 findings clerk on 2026-10-24;
  non-blocking at merge.
- Plan item(s): F0.8.
- Evidence:
  - `aria-kernel/aria_kernel/genesis_policy.py:197-206` (the three reason literals)
  - `aria-kernel/tests/test_calibration_gate.py:244` (the doctor fixture's third spelling)
  - `aria-kernel/aria_kernel/doctor.py:721` (the doctor copies the reason into its detail without
    branching on it)
- Rule: One owner per concept: a closed vocabulary that three writers spell their own way drifts
  silently; the reason should be a named constant (or Literal) the producer, the doctor and the
  tests share.
- Failure scenario: A consumer starts branching on the reason (a doctor hint, a dashboard filter)
  using one spelling and silently misses the other two.
- Close condition: the reasons are one typed constant set in genesis_policy; the doctor fixture and
  test_calibration_gate import it; a test fails when a producer or a fixture writes a reason outside
  the set.

## ARIA-LOW-837

The evidence leg of the seat law lives in the consensus_distinct_seats wrapper, not in
distinct_judge_seats, so the calibrated enforce quorum seats agreement that cites no evidence
although PLAN-v2 names the method stamp and the evidence leg as legs of the one seat function

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.8 review (lens arch), registered by the F0.8 findings clerk on 2026-10-24;
  non-blocking at merge.
- Plan item(s): F0.8.
- Evidence:
  - `aria-kernel/aria_kernel/feedback_store.py:386-406` (distinct_judge_seats: the receipt leg only)
  - `aria-kernel/aria_kernel/feedback_store.py:445-447` (the evidence leg, applied in the wrapper)
  - `aria-kernel/aria_kernel/feedback_store.py:1347` (the calibrated quorum asks
    distinct_judge_seats directly)
- Rule: PLAN-v2 §2 diversity-law row: the method stamp and the evidence leg are legs of the one seat
  function, so every consumer of the function gets them.
- Failure scenario: Two calibrated judges agree on argument alone (no evidence refs); under enforce
  they form a quorum and the consensus row is minted without evidence, while the anchor would have
  refused the same panel.
- Close condition: either the evidence leg moves into the one seat function (with the calibrated
  quorum test showing an evidence-less calibrated pair is not a quorum), or the plan row and the
  distinct_judge_seats docstring state that the evidence leg is deliberately an anchor-only leg.

## ARIA-LOW-838

The calibration gate and the consensus read different receipt sources: the gate reads the
calibration map (the first by_source model, never a method) while the consensus reads each feedback
row's model/method, so effective_calibration_gate can answer 'enforce' while every group escalates

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.8 review (lens arch), registered by the F0.8 findings clerk on 2026-10-24;
  non-blocking at merge.
- Plan item(s): F0.8.
- Evidence:
  - `aria-kernel/aria_kernel/cycle.py:2012-2019` (the calibration map carries the first by_source
    model and no method)
  - `aria-kernel/aria_kernel/cycle.py:2032` (effective_calibration_gate reads that map)
  - `aria-kernel/aria_kernel/cycle.py:2139-2140` (the consensus receives the gate's answer)
  - `aria-kernel/aria_kernel/genesis_policy.py:181-199` (the gate builds its receipts from the map)
  - `aria-kernel/aria_kernel/feedback_store.py:1347` (the consensus counts seats from the feedback
    rows)
- Rule: PLAN-v2 F0.8 / diversity-law row: one seat function over ONE receipt source per decision;
  two consumers that apply the same law to different inputs can still disagree.
- Failure scenario: The calibration map names a model for two judges (gate: enforce) while their
  feedback rows carry neither model nor method; every group escalates and doctor reports nothing
  wrong because the gate was not downgraded.
- Close condition: the gate and the consensus read the same receipt source (the calibration map
  carries method as well as model, or the gate is computed from the feedback rows' receipts), with a
  test where the gate and the quorum agree on a pair whose rows and calibration entries carry
  different legs.

## ARIA-LOW-839

test_one_diversity_function names consensus_distinct_seats as the seat function its AST finder
locates, but at HEAD the finder resolves to distinct_judge_seats (consensus_distinct_seats returns a
call, not a len), so the module docstring misleads the next reader

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F0.8 review (lens arch), registered by the F0.8 findings clerk on 2026-10-24;
  non-blocking at merge.
- Plan item(s): F0.8.
- Evidence:
  - `aria-kernel/tests/test_one_diversity_function.py:34-35` (docstring: 'today
    consensus_distinct_seats')
  - `aria-kernel/tests/test_one_diversity_function.py:71-103` (\_seat_count_functions, which finds
    the function returning len of a judge_id set)
  - `aria-kernel/aria_kernel/feedback_store.py:386-406` (distinct_judge_seats, the function the
    finder resolves to)
- Rule: Test docstrings that name the pinned function must name the one the test actually pins; a
  stale name sends the reader to the wrapper instead of the law.
- Failure scenario: A reader renames or moves consensus_distinct_seats believing it is the pinned
  seat law, and the test keeps passing because it pins another function.
- Close condition: the docstring (lines 34-35, and the line 5 mention) names distinct_judge_seats as
  the located function and consensus_distinct_seats as its consensus-row wrapper.

## ARIA-MEDIUM-814

A corrupt aria-config override silently falls back to the shipped pre-registered values.

`load_policy` returns the shipped defaults when the override fails to decode (`JSONDecodeError`,
`OSError`) or is not a JSON object. `service_expertise_policy` and `change_review_policy` read
through it, so for an override they could not read they return the shipped values, against their own
promise that the shipped value never stands in for a missing one. A truncated override carrying
`service_expertise.genesis.k_min=9` gives `k_min == 3`; an override with a trailing comma that
intends `keep_level_dev=0.99` returns `0.9`; a top-level list override is accepted. The fail-soft
branch is already on origin/main and nothing calls the new accessors yet, so there is no live effect
today.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-13 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the SE-13 landing. Verified at
  `8cc299197`.
- Plan item(s): SE-13 (PLAN section 4.3, 7.2, DECISIONS Q1, Q6).
- Evidence:
  - `aria-kernel/aria_kernel/genesis_policy.py:955-974`
  - `aria-kernel/aria_kernel/genesis_policy.py:986-990`
  - `aria-kernel/aria_kernel/preregistered_policy.py:1-11`
- Rule: fail closed on an unreadable store (the ARIA-HIGH-788 class). `load_policy` is fail-soft for
  an absent override only; a present override it cannot parse is an unreadable store, not a missing
  one.
- Close: `load_policy` returns the defaults only when the override file is absent; a present
  override that is not valid UTF-8 JSON or not a JSON object raises a named `GovernanceError` (no
  broad except), the other `load_policy` callers are checked in the same change, and a test pins
  that both accessors refuse a truncated override and a top-level list. Merges two review points
  (ssot and evidence lenses).

## ARIA-MEDIUM-815

Pre-registered SE-13 values can be changed with no trace.

A valid `aria-config/genesis_policy.json` override setting `keep_level_final=0.51` is accepted by
`service_expertise_policy`. PREREG Amendment 4 says the run is void if the blocks differ from the
registration, but it pins no digest or commit of the registered blocks (Amendment 3 sealed
`cases.jsonl` by sha256), and no code compares the parsed block with the registration.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-13 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the SE-13 landing. Verified at
  `8cc299197`.
- Plan item(s): SE-13 (PREREG Amendment 4).
- Evidence:
  - `aria-kernel/aria_kernel/genesis_policy.py:977-983`
  - `aria-kernel/aria_kernel/genesis_policy.py:1053-1089`
  - `/root/aria-handover/2026-10-21/decision-test/PREREG.md:83-90`
- Rule: a pre-registration binds only if a change to it is detectable; 'the run is void until
  reconciled' needs a registered reference to differ from and a check that compares it.
- Close: one owner records the registration digest (sha256 of the canonical JSON of the
  non-underscore keys of the `service_expertise` and `change_review` blocks) in PREREG Amendment 4
  or its successor; the DEV-check and final-run entry points compare the parsed blocks with it and
  refuse a run on mismatch, naming the differing dotted path; a test changes `keep_level_final` in
  an override and expects the refusal. The owner decides whether the digest lives in PREREG only or
  also ships beside the JSON.

## ARIA-LOW-816

Relations between pre-registered SE-13 values are checked only for looks against the look budget and
ablations against sections.

`seats_per_dev_look` (documented as 50 x 2 x 4 discovery seats) and `seats_per_cycle` (two changes
at full discovery width) are stored as independent numbers beside `service_seats_per_change` +
`lens_seats_per_change`. The parser accepts `service_seats_per_change=6` while `seats_per_dev_look`
stays 400, `keep_level_dev=0.99` with `keep_level_final=0.5`, and `seats_per_cycle=1` (below one
change's 3+1 discovery seats).

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-13 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the SE-13 landing. Verified at
  `8cc299197`.
- Plan item(s): SE-13 (PLAN section 4.3, 7.2).
- Evidence:
  - `aria-kernel/aria_kernel/data/genesis_policy_default.json:33-41`
  - `aria-kernel/aria_kernel/genesis_policy.py:1031-1040`
  - `aria-kernel/aria_kernel/genesis_policy.py:1062-1089`
  - `aria-kernel/aria_kernel/preregistered_policy.py:99-124`
- Rule: one owner per concept: a number derived from other registered numbers is computed from them
  or refused when it disagrees; the look-budget relation is checked this way, the seat envelopes and
  keep levels are not.
- Close: for each relation PLAN section 4.3 and 7.2 actually require, the dependent value is removed
  and computed from its factors, or `service_expertise_policy` / `change_review_policy` refuse a
  disagreeing set by dotted path (the owner decides which of `keep_level_dev <= keep_level_final`,
  `seats_per_cycle >= one change's discovery seats` and the dev-look envelope the spec requires);
  each refusal has a test. Merges the ssot-lens derived-envelope point and the evidence-lens
  cross-key point.

## ARIA-LOW-817

`sections_in_render_order` is described as the one section list but its vocabulary is open.

The key uses `names()` with no allowed set, so a typo registers a section no renderer has
(`invariantz` and `bogus_section` were accepted). The live `established_knowledge` renderers keep
their own hardcoded order (beliefs, conventions, anti_patterns, past_failed_attempts) until SE-6
reads this list, so the order has two owners.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-13 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the SE-13 landing. Verified at
  `8cc299197`.
- Plan item(s): SE-13, SE-6 (PLAN section 3.7).
- Evidence:
  - `aria-kernel/aria_kernel/genesis_policy.py:1044`
  - `aria-kernel/aria_kernel/preregistered_policy.py:81-96`
  - `aria-kernel/aria_kernel/data/genesis_policy_default.json:22-30`
  - `aria-kernel/aria_kernel/agent_invocations.py:561-660`
- Rule: one owner per concept; the neighbouring `removed_on_fail` list is closed by
  `PREREG_FINAL_REMOVABLE`, this one is not.
- Close: when SE-6 makes the renderer read the list, the vocabulary is closed by
  `names(allowed=...)` drawn from the renderer's one definition of its sections, the hardcoded order
  in `agent_invocations.py` is deleted, and a test pins that the rendered order equals the policy
  list and that an unknown section is refused. Merges the ssot-lens section-list point and the
  evidence-lens unknown-section point.

## ARIA-LOW-818

Single-member `one_of` pins write each value in both the code and the JSON.

`final.a3_service_knowledge_mode='off'`, `final.per_service_agents.a1/a3` and
`dev_check.section_ablation_pick` each allow exactly one value, spelled in the schema and again in
the JSON, so the JSON entry can only echo the code. When SE-7 adds
`change_review.service_knowledge_mode {on, off}` (PLAN section 7.1) the arm vocabulary has two
owners unless the pin reads that one. Not a defect today.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-13 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the SE-13 landing. Verified at
  `8cc299197`.
- Plan item(s): SE-13, SE-7 (PLAN section 7.1).
- Evidence:
  - `aria-kernel/aria_kernel/genesis_policy.py:1010-1019`
  - `aria-kernel/aria_kernel/data/genesis_policy_default.json:139`
  - `aria-kernel/aria_kernel/data/genesis_policy_default.json:143-146`
- Rule: one owner per concept: a pin whose only allowed value is spelled in code is a second copy
  that cannot disagree and cannot be set.
- Close: when SE-7 lands `change_review.service_knowledge_mode`, `final.a3_service_knowledge_mode`
  takes its allowed values from that one definition; a pin that would only echo a constant is
  deleted from the JSON (the constant stays in code) or tied to the owner by a test, so no arm name
  is spelled in two places.

## ARIA-LOW-819

`real()` raises `OverflowError` instead of a `GovernanceError` for a huge JSON integer.

`math.isfinite(int)` converts to float before the refusal runs, so `clean_report_margin` written as
the integer 1 followed by 400 zeros fails with `OverflowError: int too large to convert to float`
from `service_expertise_policy`, not a refusal naming the dotted path. The review cited `:45`; the
`isfinite` test is at `:44`.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-13 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the SE-13 landing. Verified at
  `8cc299197`.
- Plan item(s): SE-13.
- Evidence:
  - `aria-kernel/aria_kernel/preregistered_policy.py:44`
  - `aria-kernel/aria_kernel/preregistered_policy.py:1-11`
- Rule: every refusal in `preregistered_policy` is a `GovernanceError` naming the dotted path of the
  value.
- Close: `real()` refuses such an integer with a `GovernanceError` by dotted path through an
  explicit magnitude check before the float conversion (no broad except), and a test pins it for 1
  followed by 400 zeros.

## ARIA-LOW-820

Spec drift outside the repo: PLAN section 7.2 'A3 pinned' is stale against DECISIONS Q13.

The PLAN paragraph still says per-service agents are frozen out of both arms and cites 'Amendment
3'. DECISIONS Q13 (CHANGED), PREREG Amendment 4 and the shipped `final.per_service_agents` put
agents that were ACTIVE before the freeze into A1 (A3 has none; DRAFT and EVAL agents are in neither
arm). The code follows Q13; PREREG records that the 2026-10-23 case-supply amendment already took
the number 3, hence Amendment 4.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-13 package review (lean process 2026-10-24: one review, one correction, the rest as
  findings); registered by the findings clerk, not blocking the SE-13 landing. Verified at
  `8cc299197`.
- Plan item(s): SE-13 (PLAN section 7.2, DECISIONS Q13).
- Evidence:
  - `/root/aria-handover/2026-10-21/service-expertise/PLAN.md:549-551`
  - `/root/aria-handover/2026-10-21/service-expertise/DECISIONS.md:15`
  - `/root/aria-handover/2026-10-21/decision-test/PREREG.md:83-90`
  - `aria-kernel/aria_kernel/data/genesis_policy_default.json:143-146`
- Rule: one owner per concept: the A3 pin is registered in PREREG Amendment 4 and the genesis_policy
  `final` block; a PLAN paragraph that restates it differently makes a builder build the wrong A1
  arm.
- Close: PLAN section 7.2 'A3 pinned' is amended to the Q13 / Amendment 4 wording and cites
  Amendment 4. PLAN.md and DECISIONS.md live outside the repo, so the closer records the amended
  line in the SE-13 build notes.

## ARIA-MEDIUM-844

Nothing in the repo provisions the packages an adapter declares: the decision-test room's
run_aria_case.sh probes eslint-plugin-security alone (the lint-rules manifest declares four) and
ensure-node-deps decides by ts-node presence plus a lockfile stamp, so two more owners answer a
question tool_registry already answers.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F2.1 review round 1 (ssot lens non-blocking 1 and arch lens N1, merged into one
  finding), registered by the F2.1 findings clerk after re-checking each cited path:line at
  36f7b9bf2.
- Evidence:
  - `/root/aria-handover/2026-10-21/decision-test/run_aria_case.sh:107-109` (hand-written
    eslint-plugin-security probe before the node_modules hard-link; outside the repo)
  - `tools/aria-adapters/lint-rules-adapter.tool.json:73-78` (four declared packages)
  - `aria-kernel/aria_kernel/doctor.py:655-684` (adapter_dependencies organ: answers for every
    declared package)
  - `aria-kernel/aria_kernel/tool_registry.py:1103-1110` (missing_repo_local_dependencies, the one
    predicate)
  - `.github/actions/ensure-node-deps/action.yml:37-43` (install decided by ts-node presence and the
    lockfile stamp, not by any runner's repo_local_dependencies)
- Rule: One owner per concept (CLAUDE.md Architectural Approach, tier 2 make it automatic): whether
  an adapter's declared dependencies are present is answered by
  tool_registry.missing_repo_local_dependencies and nowhere else; a probe or an install step that
  restates the question is a second owner.
- Notes: Origin: F2.1 review r1, ssot lens (non-blocking 1) and arch lens (N1), merged into one row;
  parents ARIA-MEDIUM-735 (declared dependencies + doctor organ, commit 588969fbb) and PLAN-v2
  section 3 F2.1. Checked at 36f7b9bf2. The spec line 'declared adapter dependencies are provisioned
  in the room' is met only as 'checked and refused by name' (doctor organ adapter_dependencies);
  nothing in the repo installs the packages, and commit 588969fbb lists the room part under NOT
  DONE.
- Close: (1) the room's preparation reads the dependency verdict from the one predicate (the doctor
  organ or tool_registry.missing_repo_local_dependencies) instead of its own probe, with the room
  script under repo control or the probe removed from it; (2) the install step that provisions
  node_modules is driven by the registered runners' repo_local_dependencies, so no hand-kept package
  list or ts-node-only trigger remains; (3) a test pins that a workspace lacking a declared package
  is refused by that predicate.

## ARIA-LOW-845

The workflow-hygiene invariant spawns the workflow-shell-safety adapter with a hand-written argv, a
second copy of the manifest runner that tool_registry normalises, so tsconfig, heap or cwd can drift
between the gate and the registered tool; older adapter integration tests restate their runner argv
the same way.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F2.1 review round 1 (ssot lens non-blocking 2), registered by the F2.1 findings
  clerk after re-checking each cited path:line at 36f7b9bf2.
- Evidence:
  - `aria-kernel/tests/invariants/v3/test_phase_b1_argv_proven_workflow_hygiene.py:74-80`
    (\_WORKFLOW_SHELL_ADAPTER_ARGV, node_modules/ts-node/dist/bin.js without the ./ the registry
    writes)
  - `tools/aria-adapters/workflow-shell-safety-adapter.tool.json:143-155` (the manifest runner)
  - `aria-kernel/aria_kernel/tool_registry.py:77` (TS_NODE_RUNNER_PREFIX, the normalised form)
  - `aria-kernel/tests/test_typeorm_adapter_integration.py:65` (restated runner argv)
  - `aria-kernel/tests/test_event_contracts_adapter_integration.py:48` (restated runner argv)
- Rule: One owner per concept (CLAUDE.md Architectural Approach, tier 2): the argv that runs a
  registered adapter is declared in its manifest runner and normalised by tool_registry; a test that
  spawns the adapter takes it from there.
- Notes: Origin: F2.1 review r1, ssot lens (non-blocking 2); parent ARIA-LOW-736 (the R03 scanner
  moved into the adapter and the hygiene gate asks it). Checked at 36f7b9bf2; the hand-written tuple
  already differs textually from the registry's form (no ./ prefix).
- Close: the invariant builds its spawn argv from the workflow-shell-safety manifest through the
  registry's normaliser or the runner's own argv builder, and the same helper replaces the restated
  argv in the two older integration tests (or each is named why it must differ); a test pins that
  changing the manifest runner changes what the gate spawns.

## ARIA-LOW-846

The lint-rules manifest's repo_local_dependencies list restates the packages that
lint-rules.eslint.config.mjs and lint-rules-adapter.ts import; a test catches drift (tier 3) but
nothing derives the list from the imports (tier 2), so a hand-kept list remains a second owner of
the adapter's package set.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F2.1 review round 1 (ssot lens non-blocking 3), registered by the F2.1 findings
  clerk after re-checking each cited path:line at 36f7b9bf2.
- Evidence:
  - `tools/aria-adapters/lint-rules-adapter.tool.json:73-78` (the declared list)
  - `tools/aria-adapters/lint-rules.eslint.config.mjs:17-19` (tsParser, security, sonarjs imports)
  - `tools/aria-adapters/lint-rules-adapter.ts:148` (dynamic import of eslint)
  - `aria-kernel/tests/test_runner_repo_local_dependencies.py:211` (lint_rules_packages, the drift
    test's own import scan)
- Rule: Architectural-solution hierarchy (CLAUDE.md): make it automatic (tier 2) before make it
  detectable (tier 3); runner_repo_local_dependencies already derives the ts-node entry instead of
  storing it.
- Notes: Origin: F2.1 review r1, ssot lens (non-blocking 3); parent ARIA-MEDIUM-735. Checked at
  36f7b9bf2: test_the_runner_depends_on_every_package_it_imports pins the list against the import
  scan, so drift is detected, not prevented.
- Close: the package set is derived from the adapter's and the config's imports at one place (the
  registry compiler or manifest sync, the way the ts-node entry is derived) and the hand-kept list
  is removed, with the drift test then pinning the derivation; or an owner-signed note that the
  detected form is accepted, citing the cost of an import parser in the registry.

## ARIA-LOW-847

The adapter_dependencies doctor organ reads the store registry (list_tools) rather than the
workspace manifests, so before \_phase_tool_manifest_sync re-registers lint-rules-adapter a stale
store entry without repo_local_dependencies reports ok on a workspace that lacks the rule packages.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F2.1 review round 1 (ssot lens non-blocking 4), registered by the F2.1 findings
  clerk after re-checking each cited path:line at 36f7b9bf2.
- Evidence:
  - `aria-kernel/aria_kernel/doctor.py:668` (for tool in list_tools(base_dir=tools_dir))
  - `aria-kernel/aria_kernel/cycle.py:3138` (\_phase_tool_manifest_sync, the door that refreshes the
    store from tools/aria-adapters/\*.tool.json)
  - `aria-kernel/aria_kernel/tool_registry.py:1088-1100` (runner_repo_local_dependencies reads the
    stored runner's field, deriving only ts-node)
- Rule: \_check_adapter_dependencies promises to name, before a night runs, which tool the workspace
  cannot run (its docstring); a verdict taken from a stale store copy of the declaration can say ok
  where the declared packages are absent.
- Notes: Origin: F2.1 review r1, ssot lens (non-blocking 4); parent ARIA-MEDIUM-735. Checked at
  36f7b9bf2 by reading the code; the premise needs the doctor to run before the sync re-registers
  the adapter, or on a store never synced. Run order inside a night was not traced (readers:
  cli.py:7757, mcp_server.py:183, self_improvement.py:949).
- Close: the organ reads the declared dependencies from the workspace manifests, or names a store
  entry whose runner differs from its manifest; a test registers a store entry without
  repo_local_dependencies beside a manifest that has the field and pins that the organ is not ok.

## ARIA-LOW-848

The R03 rule command_substitution_in_message misses ``builtin echo "... `cmd` ..."``:
shell-script.ts effectiveArgv strips the wrappers in WRAPPERS (command, exec, sudo, ...) but not
builtin, so the command name stays 'builtin' and MESSAGE_COMMANDS never matches.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F2.1 review round 1 (arch lens N2), registered by the F2.1 findings clerk after
  re-checking each cited path:line at 36f7b9bf2.
- Evidence:
  - `tools/aria-adapters/shell-script.ts:551` (WRAPPERS has no builtin)
  - `tools/aria-adapters/shell-script.ts:571` (effectiveArgv)
  - `tools/aria-adapters/workflow-shell-safety-adapter.ts:251` (MESSAGE_COMMANDS echo, printf)
  - `tools/aria-adapters/workflow-shell-safety-adapter.ts:640` (the rule keys on the effective
    command name)
  - `scripts/deploy/production-host-control-plane.sh:25` (builtin printf is a live idiom in the
    tree; no substitution on that line)
- Rule: The R03 rule (ARIA-LOW-736): a backtick inside a double-quoted echo or printf argument is
  reported whatever wrapper runs it.
- Notes: Origin: F2.1 review r1, arch lens (N2); parent ARIA-LOW-736. Re-probed at 36f7b9bf2 through
  the adapter CLI on a three-line script: 'command echo' and plain 'echo' with a backtick in a
  double-quoted message were reported, 'builtin echo' was not. No live line in the tree combines
  builtin with a substitution, so the miss is latent.
- Close: builtin is a wrapper in shell-script.ts (as command is) and a workflow-shell-safety fixture
  or unit case pins that builtin echo and builtin printf with a double-quoted backtick are reported.

## ARIA-LOW-849

The F2.1 exit criterion 'every new finding on the existing 158 observations is a verified TP or a
named FP' has no recorded evidence: the implementer notes measure only the real tree (0 new R03
findings, 15 findings before and after) and the findings of lint-rules-adapter, once its packages
are provisioned, are unmeasured.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: the F2.1 review round 1 (arch lens N3), registered by the F2.1 findings clerk after
  re-checking each cited path:line at 36f7b9bf2.
- Evidence:
  - `/root/aria-handover/2026-10-21/PLAN-v2.md:229` (the exit criterion)
  - `/root/aria-handover/2026-10-21/build/F2.1/implementer/NOTES.md:20` (New findings on real tree:
    0 for the new rule; totals 15 before/after)
  - `tools/aria-adapters/lint-rules-adapter.tool.json:73-78` (the packages whose provisioning lets
    the adapter produce findings)
- Rule: PLAN-v2 section 3 F2.1 exit: 0 crashes, R03 caught, and every new finding on the existing
  158 observations a verified TP or a named FP.
- Notes: Origin: F2.1 review r1, arch lens (N3); parents ARIA-MEDIUM-735 and ARIA-LOW-736. Checked
  at 36f7b9bf2: the implementer NOTES and the writer and implementer logs hold no run against the
  158-observation set, and the notes name no lint-rules findings count.
- Close: run lint-rules-adapter (with its packages provisioned) and the R03 rule over the tree the
  158 observations were taken from, list every finding that is not in the baseline, and record each
  as a TP verified at path:line or as a named FP with its cause, in the F2.1 notes or the review
  doc; an empty list is recorded as such.

## ARIA-MEDIUM-850

SE-2 adds a public `runtime_profiles.FILE_WRITE_TOOLS` with exactly the members of the existing
`hooks.WRITE_TOOL_NAMES` (probe at HEAD: the two frozensets are equal). Two names now own
"file-editing tool": Layer 6's writer rule reads one and the hook broker reads the other, so one can
gain a tool without the other.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-C review round 1, ssot lens, non-blocking item 1; non-blocking, registered by the
  SE-2-C findings clerk. The SE-2
  branch (`feat/aria-se2-one-path-agent-map`) is not held on it. Line numbers are those of HEAD
  `539f7badc`, not the reviewers' `a55ac2704`.
- Evidence:
  - `aria-kernel/aria_kernel/runtime_profiles.py:72`
  - `aria-kernel/aria_kernel/hooks.py:77`
  - `aria-kernel/aria_kernel/surface_manifest_validator.py:355`
  - `aria-kernel/aria_kernel/hooks.py:144`
- Verified: Verified at 539f7badc: runtime_profiles.py:72 and hooks.py:77 are equal frozensets
  (hooks.WRITE_TOOL_NAMES == runtime_profiles.FILE_WRITE_TOOLS is True).
- Rule: One owner per concept (PLAN-v2 F0.9b ownership atlas; memory
  feedback_single_center_no_duplicates): the set of file-editing tools is named once and every
  consumer (the hook broker, the profile write-scope rule, Layer 6) reads that one name.
- Close: One module owns the file-editing tool set and the other imports it, so there is a single
  literal of {Edit, Write, MultiEdit, NotebookEdit} in aria_kernel; a test fails when a second
  literal of that set appears. `runtime_profiles.WRITE_TOOLS` (adds Bash, the write-tier profile
  test) is a different concept and stays.

## ARIA-MEDIUM-851

The routing table has a second reader with different semantics. `worktree-audit` picks the
most-specific primary and does not filter out placeholders, while `agent_routing` rejects them
(`_AGENT_RE`). The new `*ARIA lane — no Lane-A primary*` rows therefore turn `aria-kernel/**` and
`tools/aria-*` paths from "PROCESS HIGH ownership gap" (main) into the owner "ARIA lane — no Lane-A
primary", which hides the gap that the table's own rule (every changed file maps to at least one
primary) requires. It is an operator tool and not part of CI.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-C review round 1, ssot lens, non-blocking item 2; non-blocking, registered by the
  SE-2-C findings clerk. The SE-2
  branch (`feat/aria-se2-one-path-agent-map`) is not held on it. Line numbers are those of HEAD
  `539f7badc`, not the reviewers' `a55ac2704`.
- Evidence:
  - `tools/worktree-audit/worktree-audit.ts:258`
  - `tools/worktree-audit/worktree-audit.ts:357-379`
  - `.claude/shared/orchestrator-routing-table.md:98-100`
  - `.claude/shared/orchestrator-routing-table.md:129`
  - `aria-kernel/aria_kernel/agent_routing.py:37`
- Verified: Re-run at 539f7badc with the reviewer's probe-wta.ts against the origin/main table and
  the HEAD table: main reports "PROCESS HIGH ownership gap" for aria-kernel/aria_kernel/cli.py and
  tools/aria-poc/poc.py, HEAD reports "ARIA lane — no Lane-A primary" for both. worktree-audit.ts is
  byte-identical to main.
- Rule: One owner per concept: the routing table has one meaning for a placeholder primary, and
  every reader (agent_routing, worktree-audit) applies it; the table's own rule at line 129 says an
  unmatched path is a PROCESS HIGH ownership gap.
- Close: worktree-audit treats a primary cell that is not an agent name as no owner (the same rule
  as `agent_routing._AGENT_RE`), or both readers share one parser. A spec in tools/worktree-audit
  feeds the live table and pins that `aria-kernel/aria_kernel/cli.py` reports the ownership gap, not
  the placeholder.

## ARIA-LOW-852

An agent-to-paths store is left alive with no reader. `map_agent_priors` still writes
`agent-priors/agent-map.jsonl` with per-agent `scope_globs` and the hardcoded token-to-globs default
table, and `latest_agent_priors` reads it. With `related_agents_for_paths` deleted, no non-test code
in `aria_kernel` calls either function. The state surface `agent_priors_map` stays registered.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-C review round 1, ssot lens, non-blocking item 3; non-blocking, registered by the
  SE-2-C findings clerk. The SE-2
  branch (`feat/aria-se2-one-path-agent-map`) is not held on it. Line numbers are those of HEAD
  `539f7badc`, not the reviewers' `a55ac2704`.
- Evidence:
  - `aria-kernel/aria_kernel/agent_priors.py:14-44`
  - `aria-kernel/aria_kernel/agent_priors.py:66-68`
  - `aria-kernel/aria_kernel/agent_priors.py:181-196`
  - `aria-kernel/aria_kernel/state_manifest.py:761`
- Verified: Grep at 539f7badc: map_agent_priors and latest_agent_priors have callers only under
  aria-kernel/tests (test_agent_genesis_foundation, test_portability_bootstrap,
  test_agent_genesis_h4_real_exec); tools/aria-poc/poc.py has its own write_agent_priors.
- Rule: No store without a reader (memory feedback_single_center_no_duplicates; PLAN-v2 F0.9b):
  `scope_globs` stays a genesis draft field (agent_genesis.REQUIRED_DRAFT_FIELDS), not a second
  path-to-agent store that the kernel writes and nothing reads.
- Close: `map_agent_priors`, `latest_agent_priors`, `_default_scope_for_agent` and the
  `agent_priors_map` state surface are removed in one change, with the ledger-roster and portability
  tests updated; `_parse_agent` and `reviewer_names` stay (agent_network and plan_convergence read
  them). Alternatively a named non-test reader is added and the decision recorded here.

## ARIA-LOW-853

`agent_routing.ROUTING_INPUT_DIR` is the owner of the directory the kernel reads routing inputs
from, and its comment names `agent_network`'s routing hashes as a consumer. `agent_network` does not
import it: `_routing_files`, `_source_manifest` and `_source_hashes` each spell `.claude/shared`
themselves.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-C review round 1, ssot lens, non-blocking item 4; non-blocking, registered by the
  SE-2-C findings clerk. The SE-2
  branch (`feat/aria-se2-one-path-agent-map`) is not held on it. Line numbers are those of HEAD
  `539f7badc`, not the reviewers' `a55ac2704`.
- Evidence:
  - `aria-kernel/aria_kernel/agent_routing.py:31-33`
  - `aria-kernel/aria_kernel/agent_network.py:89`
  - `aria-kernel/aria_kernel/agent_network.py:102`
  - `aria-kernel/aria_kernel/agent_network.py:125`
- Verified: Re-read at 539f7badc: agent_network.py:89 (`repo / ".claude" / "shared"`), :102
  (`".claude/shared/*routing*.md"`) and :125 (`rel.startswith(".claude/shared/")`).
- Rule: One owner per concept: a directory the owner exports as a constant is imported by its
  consumers, not re-spelled (the ROUTING_INPUT_MEMBERS authority entry already does this).
- Close: `agent_network` builds its routing glob, shared directory and hash bucket from
  `agent_routing.ROUTING_INPUT_DIR`; the three literals are gone. A change to the constant then
  changes the routing hashes and the authority set together.

## ARIA-MEDIUM-854

`load_routing_table` returns `[]` when `.claude/shared/orchestrator-routing-table.md` is absent.
Gate C and `expert_review_gate` now take all their domain reviewers from that table, so a workspace
that does not resolve to a repo checkout silently yields only the independence top-up
(`security-reviewer`, `architectural-arbiter`) and records nothing. On origin/main the touch map was
compiled into the code and could not be missing.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-C review round 1, security lens non-blocking item 1 (MEDIUM) merged with ssot lens
  non-blocking item 5 (LOW); the higher severity is kept; non-blocking, registered by the SE-2-C
  findings clerk. The SE-2
  branch (`feat/aria-se2-one-path-agent-map`) is not held on it. Line numbers are those of HEAD
  `539f7badc`, not the reviewers' `a55ac2704`.
- Evidence:
  - `aria-kernel/aria_kernel/agent_routing.py:94-95`
  - `aria-kernel/aria_kernel/specialist_review_runner.py:520-534`
  - `aria-kernel/aria_kernel/expert_review_gate.py:171`
- Verified: Probe at 539f7badc: select_specialist_agents(auth-service file) with the live table
  returns 8 agents and [] with the table absent; select_expert_reviewers returns 8 agents live and
  ['security-reviewer', 'architectural-arbiter'] with the table absent.
- Rule: Fail closed with a named gap: a missing authority input is surfaced as a gap the cycle
  records, not read as "no rows" (the ARIA-HIGH-788 fail-open class).
- Close: An absent routing table raises or records a named gap (for example
  `routing_table_unavailable`) from one owner accessor that Gate C and expert_review_gate both use.
  A test drives `load_routing_table` against a directory without the table and pins that Gate C
  blocks with the named gap and that expert_review_gate requests no review without naming it.

## ARIA-LOW-855

`remaining_runtime_dependencies` scans a fixed list of dispatch modules for quoted names of the
removable security agents. The list still names `specialist_touch_map.py`, which does not exist (a
defect that predates SE-2), and it does not include `agent_routing`, `specialist_review_runner` or
the routing table. Gate C now reaches `security-reviewer` and `auth-security-expert` through the
table, so the retirement scan under-reports the runtime dependencies.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-C review round 1, ssot lens, non-blocking item 6; non-blocking, registered by the
  SE-2-C findings clerk. The SE-2
  branch (`feat/aria-se2-one-path-agent-map`) is not held on it. Line numbers are those of HEAD
  `539f7badc`, not the reviewers' `a55ac2704`.
- Evidence:
  - `aria-kernel/aria_kernel/security/parity.py:27`
  - `aria-kernel/aria_kernel/security/parity.py:34`
  - `aria-kernel/aria_kernel/security/parity.py:134-145`
- Verified: Re-read at 539f7badc: `aria-kernel/aria_kernel/specialist_touch_map.py` does not exist;
  REMOVABLE_SECURITY_AGENTS = (security-reviewer, auth-security-expert).
- Rule: A retirement gate reads every place that can dispatch the agent it retires; a scan list that
  names a deleted module and omits the live dispatch path gives a green result it has not earned.
- Close: `_RUNTIME_DISPATCH_MODULES` drops the nonexistent module and the scan covers the routing
  table (rows naming `security-reviewer` or `auth-security-expert`) and the modules that dispatch
  from it. A test with a table row naming a removable agent pins that
  `remaining_runtime_dependencies` reports it.

## ARIA-LOW-856

SE-2 removes writer agents from the routing table (a writer is never a reviewer, Q4), but
`legal-hold-auditor.md` still lists "GDPR erasure cascade (gdpr-erasure-executor primary)", and
`specialist_review_runner._TIER_1_SPECIALISTS` still contains `gdpr-erasure-executor` and
`security-architecture-writer`. The set is a profile-gating attribute and not a routing source, so
this is a prose and naming inconsistency, not a routing defect.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-C review round 1, ssot lens, non-blocking item 7; non-blocking, registered by the
  SE-2-C findings clerk. The SE-2
  branch (`feat/aria-se2-one-path-agent-map`) is not held on it. Line numbers are those of HEAD
  `539f7badc`, not the reviewers' `a55ac2704`.
- Evidence:
  - `.claude/agents/legal-hold-auditor.md:37`
  - `aria-kernel/aria_kernel/specialist_review_runner.py:157-168`
- Verified: Re-read at 539f7badc: legal-hold-auditor.md:37 and specialist_review_runner.py:163,
  :167.
- Rule: One owner per concept: the routing table is the only place that says which agent owns a
  path; agent prose and gating sets do not restate ownership with a writer as primary.
- Close: legal-hold-auditor.md names the routing table's owner for the erasure cascade (or drops the
  owner annotation), and the Tier-1 set either drops the two writer agents or a comment records that
  the set gates dispatch only and never selects a reviewer. A test pins that no agent .md claims a
  writer agent as `primary`.

## ARIA-LOW-857

`_pattern_prefix` cuts a glob at its first wildcard, so the `apps/*/src/gdpr/**`,
`apps/*/src/**/tenant*.ts` and `apps/*/src/**/entities/*.entity.ts` rows reduce to the prefix
`apps`, and `_matches` then reaches every `apps/*` path. One `apps/auth-service` file routes to 8
agents. Commit 539f7badc fixes the consequence the SE-2-C blocker named (the
`max_specialists_per_cycle` cap cutting a service's own domain expert), but the reviewer set itself
is still wider than the rows intend, so a merge asks more reviewers than the file needs.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-C review round 1, security lens non-blocking item 4 (implementer note 5);
  non-blocking, registered by the SE-2-C findings clerk. The SE-2
  branch (`feat/aria-se2-one-path-agent-map`) is not held on it. Line numbers are those of HEAD
  `539f7badc`, not the reviewers' `a55ac2704`.
- Evidence:
  - `aria-kernel/aria_kernel/agent_routing.py:53-65`
  - `aria-kernel/aria_kernel/agent_routing.py:117-126`
  - `aria-kernel/aria_kernel/agent_routing.py:149-163`
  - `.claude/shared/orchestrator-routing-table.md:102`
  - `.claude/shared/orchestrator-routing-table.md:67`
  - `.claude/shared/orchestrator-routing-table.md:36`
- Verified: Probe at 539f7badc:
  select_specialist_agents(['apps/auth-service/src/auth/jwt.strategy.ts']) returns 8 agents
  (auth-security-expert, compliance-expert, legal-hold-auditor, security-reviewer,
  audit-trail-completeness-auditor, data-expert, database-reviewer, multi-tenant-saas-expert). The
  four-service case (farm, sensor, hr, billing) now keeps all four service experts.
- Rule: A glob row reviews the paths it matches: the row's prefix is a necessary condition, not the
  match; the derived reviewer set per surface equals the Q4 literal for the files in it.
- Close: A row with a wildcard before its last literal segment is matched with the glob (not only
  its literal prefix), or each such row is split per service. A test pins that
  `reviewing_agents_for_paths(['apps/auth-service/src/auth/jwt.strategy.ts'])` does not contain the
  reviewers of the gdpr, tenant and entity rows and still contains the auth owner.

## ARIA-LOW-858

`request_implementation_expert_reviews` requires only four checks (`required`) before it mints
review requests, and it reads the routing table from `context.workspace_root`, which is the PR-head
worktree `_evaluate_pre_merge_perimeter` shapes. When `readonly_paths_untouched_at_merge` or
`forbidden_scope_normalized` fails, the table may be the one the PR edited. The merge is still
refused and the implementer room's read-only mount already blocks the edit, so the outcome is
unchanged. The comment "the change being reviewed cannot have edited it" and ADR-049's "that table
is always the base table" are nevertheless wrong.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-C review round 1, security lens non-blocking item 2; non-blocking, registered by
  the SE-2-C findings clerk. The SE-2
  branch (`feat/aria-se2-one-path-agent-map`) is not held on it. Line numbers are those of HEAD
  `539f7badc`, not the reviewers' `a55ac2704`.
- Evidence:
  - `aria-kernel/aria_kernel/expert_review_gate.py:134-148`
  - `aria-kernel/aria_kernel/expert_review_gate.py:168-171`
  - `aria-kernel/aria_kernel/merge_authority.py:764-780`
  - `aria-kernel/aria_kernel/merge_authority.py:833-843`
  - `docs/adr/049-aria-routing-inputs-authority.md:67-68`
- Verified: Re-read at 539f7badc: required at expert_review_gate.py:134-137 names four checks; the
  table is loaded at :171 from context.workspace_root; merge_authority.py:780 shapes the PR-head
  worktree and :833-843 requests from inside it.
- Rule: A claim in a comment or an ADR holds for every path that reaches the code it describes;
  reviewer selection reads an authority input at the base, or only after the checks that make it
  trustworthy.
- Close: `request_implementation_expert_reviews` reads the table at `base_sha`, or
  `readonly_paths_untouched_at_merge` and `forbidden_scope_normalized` join `required`; the comment
  and ADR-049 are corrected to match. A test mints reviews for a PR head that edits
  `.claude/shared/orchestrator-routing-table.md` and pins that the edited table is not used.

## ARIA-LOW-859

`validate_maintenance_agent_isolation` refuses a reviewer whose `tools:` include a file-editing
tool. `FILE_WRITE_TOOLS` excludes Bash, and `test-runner` (tools: Read, Grep, Glob, Bash) is the
primary of the `**/*.spec.ts`, `**/*.test.ts` and `tests/**` rows, so a reviewer can run Bash.
Separately, when `resolve_agent_md_path` returns `None` for a routed agent the validator
`continue`s, so an agent named in the table with no resolvable file is not reported.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-C review round 1, security lens non-blocking item 3; non-blocking, registered by
  the SE-2-C findings clerk. The SE-2
  branch (`feat/aria-se2-one-path-agent-map`) is not held on it. Line numbers are those of HEAD
  `539f7badc`, not the reviewers' `a55ac2704`.
- Evidence:
  - `aria-kernel/aria_kernel/runtime_profiles.py:72`
  - `.claude/shared/orchestrator-routing-table.md:68`
  - `.claude/agents/test-runner.md:6`
  - `aria-kernel/aria_kernel/surface_manifest_validator.py:352-354`
- Verified: Re-read at 539f7badc: runtime_profiles.py:72 excludes Bash; test-runner.md:6 is `tools:
Read, Grep, Glob, Bash`; routing-table row 68 names test-runner;
  surface_manifest_validator.py:352-354 resolves the agent and continues on None.
- Rule: A validator that guards a reviewer-independence rule names every way the reviewer can write
  the tree it reviews, and reports an input it cannot evaluate instead of passing it.
- Close: The Layer 6 decision on Bash is recorded (a reviewer may run Bash only under a read-only
  profile, or Bash is a writer tool for this rule) and pinned by a test on test-runner. A routed
  agent with no resolvable .md appends a failure with its own reason (for example
  `routed_agent_without_definition`) instead of `continue`. Both are tested on a fixture first.

## ARIA-LOW-860

SE-2 adds `.claude/shared/` to the derived authority set and CODEOWNERS, a change to the
implementer's read-only perimeter. PLAN §8 SE-2 and `implementation_safety.py` require "ADR +
arbiter approval + invariant amendment" for that. ADR-049 is `Status: Proposed` and says the arbiter
ruling is obtained separately by the program lead; no ruling is cited.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-2-C review round 1, security lens non-blocking item 5 (process); non-blocking,
  registered by the SE-2-C findings clerk. The SE-2
  branch (`feat/aria-se2-one-path-agent-map`) is not held on it. Line numbers are those of HEAD
  `539f7badc`, not the reviewers' `a55ac2704`.
- Evidence:
  - `docs/adr/049-aria-routing-inputs-authority.md:3`
  - `aria-kernel/aria_kernel/implementation_safety.py:88-89`
- Verified: Re-read at 539f7badc: docs/adr/049-aria-routing-inputs-authority.md:3-4 reads "Status:
  Proposed. The architectural-arbiter ruling is obtained separately...".
- Rule: PLAN section 8 SE-2 and implementation_safety.py: adding or removing a read-only path takes
  ADR + arbiter approval + invariant amendment; an ADR changes to Accepted only with the ruling
  cited.
- Close: The architectural-arbiter ruling on ADR-049 is obtained, cited in the ADR, and its Status
  is changed to Accepted, before the SE-2 pull request merges. If the arbiter rules against, the
  READONLY change is reverted in the same pull request.

## ARIA-MEDIUM-824

`harness.py review_change` runs the cycle and the `ci_executor.py --drain` under `{**os.environ}`,
where the Stage J it replaces ran under an `env -i` allowlist. `GH_TOKEN`, `GITHUB_*`,
`ANTHROPIC_API_KEY`, `GIT_DIR` and ambient `ARIA_*` settings reach code run from the room tree, and
the room environment now has two definitions of different hermeticity. The kernel tripwire (iii)
covers only the in-process `run_enterprise_cycle`, not the harness or the drain.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: D1 review round 1, ssot lens (room env defined twice) and security lens (the leak),
  merged into one finding. Registered by the WP-D1 findings clerk after re-checking the evidence at
  `258c14657`.
- Evidence:
  - `tools/aria-acceptance/harness.py:519-530`
  - `tools/aria-acceptance/harness.py:541-545`
  - `tools/aria-acceptance/harness.py:562-564`
  - `tools/aria-poc/ci_executor_drain.py:860`
  - `tools/aria-poc/ci_executor_drain.py:938`
  - `tools/aria-poc/ci_executor_drain.py:1473-1474`
  - `aria-kernel/aria_kernel/evidence_probe.py:179-185`
  - `/root/aria-handover/2026-10-21/decision-test/run_aria_case.sh:64-95`
- Rule: Hermetic room (WP-D1 exit iii, DESIGN-discovery D1): the room environment is an allowlist
  with one definition (`room_env` of `run_aria_case.sh`: 'No GH/GITHUB/RUNNER/GIT\_/ANTHROPIC');
  CLAUDE.md one owner per concept.
- Citation note: the review cited `ci_executor.py:1030` for the `GITHUB_OUTPUT` write. That is the
  per-request child's write, and the drain overrides `GITHUB_OUTPUT` per child
  (`ci_executor_drain.py:938`). The path that reaches an ambient `GITHUB_OUTPUT` is the drain's own
  summary write (`ci_executor_drain.py:860`, `:1473-1474`). No passive harm was reproduced:
  `change_review` runs no GitHub phase.
- Close: the harness builds the room environment from one shared allowlist (no `{**os.environ}`); a
  test sets `GH_TOKEN`, `GITHUB_OUTPUT`, `GIT_DIR` and `ANTHROPIC_API_KEY` in the parent and asserts
  none reaches the cycle or drain subprocess env and the `GITHUB_OUTPUT` file is untouched.

## ARIA-MEDIUM-825

`run_aria_case.sh` still runs Stage J through its embedded helper (`cmd_mint`, `cmd_settle`,
`cmd_promote` over the private kernel functions `_select_findings`, `_sample_id` and
`_resolve_workspace_head_sha`). The private settle loop stays a live second owner beside
`harness.py review-change` until the driver, which lives outside the repo, is switched.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: D1 review round 1, ssot lens. Registered by the WP-D1 findings clerk after re-checking
  the evidence at `258c14657`.
- Evidence:
  - `/root/aria-handover/2026-10-21/decision-test/run_aria_case.sh:445-458`
  - `/root/aria-handover/2026-10-21/decision-test/run_aria_case.sh:279-349`
  - `/root/aria-handover/2026-10-21/decision-test/run_aria_case.sh:390-391`
  - `tools/aria-acceptance/harness.py:503-505`
- Rule: One owner per concept (CLAUDE.md); DESIGN-discovery D1 row: 'Retires the private-function
  Stage J of `run_aria_case.sh`'.
- The commit message of `258c14657` records the driver switch as the operator's step; no repo gate
  sees the script.
- Close: `run_aria_case.sh` Stage J calls `harness.py review-change`, and the helper's `cmd_mint`,
  `cmd_settle`, `cmd_promote` and their private kernel imports are deleted. Verified by reading the
  script at close time.

## ARIA-MEDIUM-826

Changed file paths of the reviewed change are rendered raw, newlines included, into the
change-intelligence `suggested_prompt` outside any untrusted tag. `resolve_change_subject` takes
them from `git diff --name-only -z` and `dispatch_change_intelligence` joins them into the prompt,
so a path containing a newline can plant its own lines, including a closing tag, in the agent's task
text.

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: D1 review round 1, security lens. Registered by the WP-D1 findings clerk after
  re-checking the evidence at `258c14657`.
- Evidence:
  - `aria-kernel/aria_kernel/pr_tracking.py:142-151`
  - `aria-kernel/aria_kernel/pr_tracking.py:281-282`
  - `aria-kernel/aria_kernel/agent_invocations.py:1142`
- Rule: PLAN-v2 F4.0 trust boundary and DESIGN-discovery D2 row: change content reaches the agent
  only inside `<untrusted_*>` tags (diff hunks in `<untrusted_diff>`).
- Same class as the merge feed on main (the same raw join of PR `changed_files`); D1 only adds a new
  path source. D2 owns `<untrusted_diff>`, so this is not a D1 blocker. The security reviewer's
  probe (a head adding a file whose name contains a newline and a closing tag) put that text into
  `suggested_prompt` as its own lines.
- Close: D2 renders changed paths inside an untrusted tag with control characters and angle brackets
  escaped or refused by name; a test with a newline-and-closing-tag path pins it for the operator
  subject and the merge feed.

## ARIA-LOW-827

`harness.py review_change` spells the session-store variable as the literal `ARIA_SESSION_STORE_DIR`
and defines the room store's extra layout (`sessions`, `logs`, `home/xdg/*`) itself, instead of
importing `session_continuity.SESSION_STORE_ENV_VAR` and keeping the layout in `state_store` beside
the four store roots.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: D1 review round 1, ssot lens. Registered by the WP-D1 findings clerk after re-checking
  the evidence at `258c14657`.
- Evidence:
  - `tools/aria-acceptance/harness.py:522`
  - `tools/aria-acceptance/harness.py:531`
  - `aria-kernel/aria_kernel/session_continuity.py:51`
  - `aria-kernel/aria_kernel/state_store.py:393-411`
- Rule: One owner per concept (CLAUDE.md); HARNESS section 2.1 store binding from the kernel's one
  definition.
- Citation correction: the review cited `harness.py:586,595`; at `258c14657` they are `:522` and
  `:531`.
- Close: `harness.py` imports `SESSION_STORE_ENV_VAR`, takes the room layout and binding from one
  function beside `store_root_environment`, and holds no `ARIA_*` literal.

## ARIA-LOW-828

`state_store.store_root_environment` spells `root / TOOLS_SUBDIR` and `root / FINDINGS_SUBDIR`
itself, where `store_environment` called `tools_root(store)` and `findings_root(store)` until
`258c14657`, so the same path shape now has two expressions.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: D1 review round 1, ssot lens. Registered by the WP-D1 findings clerk after re-checking
  the evidence at `258c14657`.
- Evidence:
  - `aria-kernel/aria_kernel/state_store.py:401-403`
  - `aria-kernel/aria_kernel/state_store.py:322-323`
  - `aria-kernel/aria_kernel/state_store.py:332-333`
- Rule: One owner per concept (CLAUDE.md): a store root's subdirectory has one expression.
- Citation correction: the review cited `state_store.py:518-520`; at `258c14657` the joins are
  `:401-403`. `tools_root`/`findings_root` take a `StateStore` and `store_root_environment` takes a
  root `Path`, which is why the refactor re-spelled the join.
- Close: `tools_root`, `findings_root` and the workspace base are defined once over the root path
  (the `StateStore` forms delegate) and `store_root_environment` calls them; no second
  `root / SUBDIR` join remains.

## ARIA-LOW-829

`harness.py review_change` derives `cycle_id` from a one-second UTC stamp
(`review-change-<YYYYmmddTHHMMSSZ>-c<round>`), so two review-change runs on one store within the
same second get the same `cycle_id` and overwrite each other's logs.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: D1 review round 1, ssot lens. Registered by the WP-D1 findings clerk after re-checking
  the evidence at `258c14657`.
- Evidence:
  - `tools/aria-acceptance/harness.py:533`
  - `tools/aria-acceptance/harness.py:540`
  - `tools/aria-acceptance/harness.py:547`
  - `tools/aria-acceptance/harness.py:566`
- Rule: A `cycle_id` names exactly one cycle of a store; the harness keys `logs/<cycle_id>.*` by it.
- Whether the kernel itself refuses a repeated `cycle_id` on one store was not probed.
- Close: the `cycle_id` is unique per run (sub-second stamp plus pid, or a uuid); a test pins
  distinct ids for two calls in the same second.

## ARIA-LOW-830

`test_harness_review_change.py` covers only the usage errors of `review-change`. The cycle, drain,
cycle settle loop and the `settled`/`passed` flag have no test.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: D1 review round 1, ssot lens. Registered by the WP-D1 findings clerk after re-checking
  the evidence at `258c14657`.
- Evidence:
  - `tools/aria-acceptance/test_harness_review_change.py:48-66`
  - `tools/aria-acceptance/harness.py:539-571`
- Rule: CLAUDE.md test rules: new behaviour is test-first; the settle loop is the unit D1 adds to
  the harness.
- The reviewer's manual probe with `rounds=0` on a two-commit fixture worked (run 1 minted 1, run 2
  minted 0, tree clean). Kernel-side mode tests are in
  `aria-kernel/tests/test_cycle_change_review_mode.py`.
- Close: a harness test drives `review_change` with the drain stubbed at the subprocess boundary and
  pins: settled in round 1; drained then settled in round 2; stopped at `rounds` with `settled`
  false while requests stay open; a nonzero cycle exit gives `passed` false with the named error.

## ARIA-LOW-831

`pr_tracking.subject_open_request_ids` loads the request ledger twice and indexes
`states[request_id]` directly, so a request row that `derive_request_states` skips (a falsy
`request_id`) raises `KeyError` instead of a refusal by name.

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: D1 review round 1, security lens (a correctness point, not a security one). Registered
  by the WP-D1 findings clerk after re-checking the evidence at `258c14657`.
- Evidence:
  - `aria-kernel/aria_kernel/pr_tracking.py:321-333`
  - `aria-kernel/aria_kernel/agent_invocations.py:3646-3647`
- Rule: Refuse by name, never crash with a bare `KeyError` (the `change_review_*` `GovernanceError`
  family of `resolve_change_subject`).
- Found by the security lens as a correctness point. Read from the code, not reproduced; it crashes
  the cycle, it does not pass.
- Close: the subject's open ids and their states come from one ledger load, or a row without a state
  is refused by name (`change_review_request_state_missing:<id>`); a test with such a row pins the
  refusal.

## ARIA-MEDIUM-840

The impact closure's import edges carry no evidence site: `impact_graph.impact_closure` reports
reason `import` with evidence `None`, because the cached project graph records project-to-project
edges and not the import line

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 implementer (87ef59330), kept out of the package's 500-line budget.
- Evidence:
  - `aria-kernel/aria_kernel/impact_graph.py:105`
  - `aria-kernel/aria_kernel/impact_graph.py:915`
- Rule: service-expertise PLAN §1.1 step 3: each closure entry names its edge kind and the edge's
  evidence `path:line`.
- Close: the graph builder records the first import site of each project edge, the cache publishes
  it, the closure reports it, and `test_impact_closure.py` pins token-lib's evidence.

## ARIA-MEDIUM-841

A change to an event interface is recognised as changing event type T only when a hunk covers the
line of its `eventType` member: SE-3's `event_definitions` carry that one line and not the
interface's extent, so a hunk that changes only another field ranks no producer or consumer of T

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 implementer (87ef59330).
- Evidence:
  - `aria-kernel/aria_kernel/impact_graph.py:170`
  - `aria-kernel/aria_kernel/impact_graph.py:184`
  - `tools/gates/event-consumer-index.ts:1516`
  - `tools/gates/event-consumer-index.ts:1524`
- Rule: service-expertise PLAN §1.2 step 2: changed hunks that intersect a definition give the
  changed types.
- Close: `event_definitions` carry the declaration's first and last line (additive), the closure
  intersects hunks with that extent, and a fixture hunk on a non-`eventType` field of an interface
  reaches the type's producer and consumer.

## ARIA-MEDIUM-842

The plan-coverage witness still maps a plan's paths to projects through its own nx graph
(`projectFor` over `npx nx graph`) for `closure.projects` and `unmapped_paths`, beside the kernel's
one key `project_for_path`, and builds that graph on every coverage run

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 implementer (91048d66c). SE-4 removed the witness's `project:` and
  `event-consumer:` nodes; the touched-project listing and unmapped paths remain.
- Evidence:
  - `tools/gates/plan-coverage-witness.ts:208`
  - `tools/gates/plan-coverage-witness.ts:230`
  - `tools/gates/plan-coverage-witness.ts:313`
  - `aria-kernel/aria_kernel/impact_graph.py:964`
- Rule: one owner per concept (service-expertise PLAN §2 row 'Path -> service/project key').
- Close: plan coverage hands the witness the closure's touched projects and unknown files with
  `closure_nodes`; the witness drops `--graph`, `loadGraph` and `projectFor`.

## ARIA-MEDIUM-843

Every workspace-level closure caller (plan admission, the cycle's service examination, the learning
impact hook, the `impact service-order` CLI) computes code facts on the live checkout's HEAD, which
must be clean and carry the TypeScript toolchain; otherwise the closure holds and plan admission
refuses every finding-origin plan with `admission_scope_missing:contract_edges_unavailable:<reason>`

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 implementer (87ef59330), as the declared PLAN Risk 12 state. Not measured on the
  ARIA runner checkout: ARIA is paused and no cycle was run.
- Evidence:
  - `aria-kernel/aria_kernel/plan_origin.py:478`
  - `aria-kernel/aria_kernel/plan_origin.py:482`
  - `aria-kernel/aria_kernel/cycle.py:2503`
  - `aria-kernel/aria_kernel/learning.py:272`
  - `aria-kernel/aria_kernel/cli.py:6207`
- Rule: service-expertise PLAN §3.3 and Risk 12: code facts are computed once per change subject on
  its base tree; a hold is declared, never hidden.
- Close: D5's base worktree supplies the facts tree to these callers, or the facts compute on the
  runner checkout at HEAD with a success rate reported over DEV runs and recorded against this row.

## ARIA-HIGH-861

The SE-4 closure adds gateway_subgraph and event nodes at depth 1 to every plan, and the pre-merge
perimeter refuses every waiver (coverage_waiver_adjudication_unavailable), so a plan touching a
subgraph service or an event producer can pass pre-merge coverage only by also touching every
contract neighbour (auth-service alone: 5 neighbours, 0 import dependents)

- Severity: HIGH; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (arch lens), registered by the SE-4 findings clerk. Re-measured at HEAD
  03d718c40: impact_closure over apps/auth-service/src/main.ts with real code facts (19.3 s) at
  depth 1 returns ai-service, farm-service, messaging-service and notification-service (event) and
  gateway-api (gateway_subgraph), and no import dependent. The witness reports every closure node
  without a waiver as uncovered, and merge_authority refuses any payload that carries waived
  entries. Not measured: the share of earlier DEV plans this would refuse.
- Evidence:
  - `aria-kernel/aria_kernel/merge_authority.py:1292-1296`
  - `aria-kernel/aria_kernel/plan_coverage.py:388-411`
  - `aria-kernel/aria_kernel/plan_coverage.py:53`
  - `aria-kernel/aria_kernel/impact_graph.py:112-121`
  - `tools/gates/plan-coverage-witness.ts:409-418`
- Rule: service-expertise PLAN Risk 13: the plan-coverage behaviour delta is listed in the PR; its
  effect at the merge perimeter, which accepts no waiver, is not, and a gate must not be fed nodes
  that only an adjudicated waiver can clear.
- Close: Either the pre-merge perimeter accepts a waiver through the critic's accepted
  request/result/artifact chain (the branch merge_authority.py:1294-1295 keeps closed), or
  contract-edge nodes stop gating the merge; test_merge_authority pins an auth-service-only plan
  with an adjudicated waiver chain (passes) and without one (refused), and the closing commit
  reports the plan refusal rate over DEV plans.

## ARIA-MEDIUM-862

impact_closure and plan_downstream_impact read the fingerprint-matched service-order cache and
ignore nx_graph_file, while plan_service_analysis_order builds its order and counts from
\_project_graph(nx_graph_file): one answer can mix two graphs (probe: dependents [c] but impacted
[a-lib, b]; origin/main gave [a-lib, c])

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (ssot lens), registered by the SE-4 findings clerk. Reproduced at HEAD
  03d718c40 on a synthetic tree (b imports a-lib by tsconfig alias, the nx graph file says c depends
  on a-lib, the cache published first by a plain cached_service_analysis_order call):
  plan_service_analysis_order gives order dependents [['c']] and impacted_projects ['a-lib', 'b'],
  plan_downstream_impact gives graph_source local_import_scan_v1 and downstream ['b']. On
  origin/main both used the given graph (impacted ['a-lib', 'c'], graph_source nx_graph_json). Only
  the operator CLI `impact service-order --nx-graph` passes nx_graph_file, so the reach is narrow.
- Evidence:
  - `aria-kernel/aria_kernel/impact_graph.py:102`
  - `aria-kernel/aria_kernel/impact_graph.py:226-235`
  - `aria-kernel/aria_kernel/impact_graph.py:355`
  - `aria-kernel/aria_kernel/impact_graph.py:369-378`
  - `aria-kernel/aria_kernel/impact_graph.py:435-436`
- Rule: one owner per concept: one graph per answer (service-expertise PLAN §2 row 'Service impact
  closure').
- Close: Closure, order and counts derive from one graph: a given nx_graph_file is that graph (it
  keys the cache or bypasses it) and an absent one means the cache; or the parameter is removed from
  the four functions. test_impact_closure pins the probe above: impacted ['a-lib', 'c'] and
  graph_source nx_graph_json.

## ARIA-MEDIUM-863

A held cycle_service_examination returns no examination_order, and \_phase_service_mission_seed
reads
exam.get('examination_order') or [] without reading the hold, so it seeds only the CORE services and
drops every evidence-backed and pressure-backed service with no disclosure

- Severity: MEDIUM; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (arch lens), registered by the SE-4 findings clerk. Checked at HEAD
  03d718c40: the hold branch of cycle_service_examination returns the examination without
  examination_order, impacted_projects and agent_coverage_gaps; cycle.py reads no 'hold' key of the
  examination anywhere, so the seeder's target list is SERVICE_HARDENING_CORE plus an empty
  evidence_backed list.
- Evidence:
  - `aria-kernel/aria_kernel/cycle.py:2503-2509`
  - `aria-kernel/aria_kernel/cycle.py:2720-2725`
  - `aria-kernel/aria_kernel/impact_graph.py:633-635`
- Rule: service-expertise PLAN §3.3 and Risk 12: a hold is declared, never hidden; a held closure
  must not look like a closure that reaches nothing.
- Close: The seeder reads exam['hold'] and discloses it by name in the phase result instead of
  seeding the CORE set alone; test_cycle pins a held examination: the phase result names
  `contract_edges_unavailable:<reason>` and mints no mission from the absent order.

## ARIA-LOW-864

GATEWAY_PROJECT = 'gateway-api' in impact_graph is a second copy of the service catalog's gateway
nxProject: subgraphs.json does not carry it, so a catalog rename leaves the gateway_subgraph edge
pointing at a project that does not exist

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (ssot lens), registered by the SE-4 findings clerk. Checked at HEAD
  03d718c40: the catalog entry serviceId 'gateway-api' has nxProject 'gateway-api' (index.ts:421);
  subgraphs.json lists the eleven subgraph nxProjects and no gateway entry.
- Evidence:
  - `aria-kernel/aria_kernel/impact_graph.py:51`
  - `aria-kernel/aria_kernel/impact_graph.py:112-116`
  - `platform/libs/service-catalog/src/index.ts:421`
  - `scripts/service-catalog/generate-artifacts.ts:140`
- Rule: one owner per concept: the service catalog owns the gateway's nx project name.
- Close: The generator of subgraphs.json (scripts/service-catalog/generate-artifacts.ts) emits the
  gateway's nxProject, impact_graph reads it from the file and GATEWAY_PROJECT is deleted;
  test_impact_closure pins that a fixture subgraphs.json naming another gateway project moves the
  edge.

## ARIA-LOW-865

The merge-time coverage check pops closure_nodes from the witness input and only checks that the
hash-bound manifest echoes them; nothing re-derives the node set from the kernel closure, so the
input file's closure_nodes are trusted (on origin/main the witness derived its nodes from plan-bound
paths)

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (ssot lens), registered by the SE-4 findings clerk. Checked at HEAD
  03d718c40: closure_nodes appears in merge_authority.py only at the pop and the two comparisons
  against the manifest. Exploiting it needs a writer of tools/coverage, so this is hardening.
- Evidence:
  - `aria-kernel/aria_kernel/merge_authority.py:1267-1280`
  - `aria-kernel/aria_kernel/plan_coverage.py:402-413`
- Rule: one owner per concept: the closure node set has one derivation (impact_graph.impact_closure)
  and the merge check compares against it, not against an echo of its own input.
- Close: merge_authority recomputes the node set from the kernel closure over the plan's affected
  paths on the bound base (or checks it against the sealed code facts in the request row) and
  refuses a differing input by name; test_merge_authority pins an emptied closure_nodes with a
  matching manifest echo as refused.

## ARIA-LOW-866

Code facts at a checkout's HEAD are computed two ways: compute_service_facts_at_head passes base_sha
`workspace_head_sha(workspace) or ''`, and compute_plan_coverage reads the same HEAD with `or
'unknown'` and calls compute_service_facts inline

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (ssot lens), registered by the SE-4 findings clerk. Checked at HEAD
  03d718c40: an unreadable HEAD gives head_unreadable in both spellings (\_base_tree_error tests the
  HEAD read itself), so the two sentinels have no observable difference today; the duplication is
  structural.
- Evidence:
  - `aria-kernel/aria_kernel/plan_coverage.py:377`
  - `aria-kernel/aria_kernel/plan_coverage.py:384-386`
  - `aria-kernel/aria_kernel/plan_coverage.py:572-577`
- Rule: one owner per concept: 'the code facts of this checkout' is computed by one function.
- Close: compute_plan_coverage calls compute_service_facts_at_head and takes computed_at_sha from
  the facts it returns, so one function owns the HEAD read and the sentinel; a test pins that an
  unreadable HEAD gives the same named error from both callers.

## ARIA-LOW-867

Test fixtures still carry the deleted witness report key event_consumers (a dead shape beside the
new closure_nodes) in three files

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (ssot lens), registered by the SE-4 findings clerk. Checked at HEAD
  03d718c40: no source file under aria-kernel/aria_kernel or tools/gates mentions event_consumers;
  the three fixtures are the only remaining occurrences.
- Evidence:
  - `aria-kernel/tests/test_plan_coverage.py:43`
  - `aria-kernel/tests/test_impact_closure.py:539`
  - `aria-kernel/tests/test_plan_coverage_gate.py:301`
- Rule: a fixture states the shape its producer emits: \_coverage_report_fields and the witness no
  longer know event_consumers.
- Close: The three fixtures carry closure_nodes (the list in the report, the count in
  closure_summary) and no event_consumers key; grep for event_consumers in aria-kernel/tests finds
  nothing.

## ARIA-LOW-868

twin_context_for_files still answers 'which projects does this change reach' with its own depth-1
dependents set (touched projects plus their direct dependents from the map), beside
impact_graph.impact_closure over import, gateway_subgraph and event edges

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (ssot lens), registered by the SE-4 findings clerk. Checked at HEAD
  03d718c40. The review named the function twin.impact_preview; no such function exists, the lines
  it cites are in twin_context_for_files. Pre-existing and left alone by SO-05.
- Evidence:
  - `aria-kernel/aria_kernel/twin.py:659-665`
  - `aria-kernel/aria_kernel/twin.py:680-682`
  - `aria-kernel/aria_kernel/impact_graph.py:63`
- Rule: one owner per concept (service-expertise PLAN §2 row 'Service impact closure'); SE-4 leaves
  Twin untouched by SO-05, so this second answer is tracked here.
- Close: twin_context_for_files takes impacted_projects from impact_closure's node set (computed
  once per change subject by its caller) or the field is dropped from the twin context; a test pins
  that an auth-service file's twin context lists the same impacted projects as impact_closure at
  depth 1.

## ARIA-LOW-869

cycle_service_examination maps the changed files to projects twice: impact_closure returns 'touched'
and the function then runs its own \_project_for_path counts loop over the same roots; the results
agree only because both end in project_for_path

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (ssot lens), registered by the SE-4 findings clerk. Checked at HEAD
  03d718c40: both walks resolve through project_for_path (impact_closure directly, the counts loop
  through the \_project_for_path adapter) over the same cache roots.
- Evidence:
  - `aria-kernel/aria_kernel/impact_graph.py:555-563`
  - `aria-kernel/aria_kernel/impact_graph.py:105-106`
- Rule: one owner per concept: one walk from changed file to project per answer (service-expertise
  PLAN §2 row 'Path -> service/project key').
- Close: impact_closure returns the per-project changed-file counts together with 'touched' and
  cycle_service_examination reads them; the counts loop and its second normalize_paths pass are
  deleted, and test_impact_closure pins the counts.

## ARIA-LOW-870

impact_closure builds its hold reason with a defensive fallback, (service_facts.get('witness') or
{}).get('error'): malformed facts that are not computed and carry no witness give the hold
'contract_edges_unavailable:None', hiding a malformed-input defect behind a well-formed hold name

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (arch lens), registered by the SE-4 findings clerk. Checked at HEAD
  03d718c40; the review's probe of malformed facts gave 'contract_edges_unavailable:None'.
- Evidence:
  - `aria-kernel/aria_kernel/impact_graph.py:97`
  - `aria-kernel/aria_kernel/plan_coverage.py:530-534`
- Rule: no defensive fallbacks (CLAUDE.md Architectural Approach): compute_service_facts documents
  that every non-computed result carries witness.error.
- Close: The reason reads `service_facts['witness']['error']` directly, so malformed facts raise at
  the boundary; test_impact_closure pins both: unavailable facts give the named hold, facts without
  a witness raise.

## ARIA-LOW-871

plan_impact declares service_facts optional (default None) and then raises service_facts_missing
when a workspace_root is given: a conditionally required parameter shaped as optional, on a function
with no production caller

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (arch lens), registered by the SE-4 findings clerk. Checked at HEAD
  03d718c40: no module under aria-kernel/aria_kernel calls plan_impact. impact.plan_impact is
  assigned to the F0.9b tombstone (ARIA-MEDIUM-791, SO-17).
- Evidence:
  - `aria-kernel/aria_kernel/impact.py:20`
  - `aria-kernel/aria_kernel/impact.py:43-44`
- Rule: make the wrong call impossible (CLAUDE.md hierarchy tier 1): a parameter required in a
  branch is typed required in the signature.
- Close: F0.9b tombstones impact.plan_impact (ARIA-MEDIUM-791) and this row closes with it; if the
  function survives, service_facts is a required keyword and the workspace_root=None branch is
  removed.

## ARIA-LOW-872

The `impact service-order` CLI computes code facts at HEAD on every call (two ts-node runs, 19.3 s
in this clerk's probe), although plan_service_analysis_order calls the closure only when
--changed-file is given; without it the facts are computed and never read

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (arch lens), registered by the SE-4 findings clerk. Checked at HEAD
  03d718c40; the review measured about 17 s, this clerk's probe measured 19.3 s for
  compute_service_facts_at_head. Related to ARIA-MEDIUM-843, which covers the callers that do need
  the facts.
- Evidence:
  - `aria-kernel/aria_kernel/cli.py:6205-6212`
  - `aria-kernel/aria_kernel/impact_graph.py:359-372`
- Rule: compute on demand: facts are a per-change-subject input (service-expertise PLAN §3.3), not a
  per-invocation cost.
- Close: The CLI computes code facts only on the --changed-file path and the order-only path
  computes none; test_cli pins that `impact service-order` without --changed-file runs no facts
  entry.

## ARIA-LOW-873

A base tree without infrastructure/apollo-router/subgraphs.json gives impact_closure no
gateway_subgraph edge and no hold: \_subgraph_lines returns {} for an absent file, so the edge kind
is dropped silently, while an unreadable file holds by name

- Severity: LOW; owner: Okan-wqm; deadline: 2026-11-20.
- Raised by: SE-4 review (arch lens), registered by the SE-4 findings clerk. Checked at HEAD
  03d718c40: the docstring of \_subgraph_lines states 'No file means no subgraph relation.'
- Evidence:
  - `aria-kernel/aria_kernel/impact_graph.py:99`
  - `aria-kernel/aria_kernel/impact_graph.py:160-161`
- Rule: service-expertise PLAN §3.3 and Risk 12: a hold is declared, never hidden; a closure missing
  an edge kind must say so.
- Close: An absent subgraphs.json holds as `contract_edges_unavailable:subgraphs_missing:<relpath>`
  (the file is generated and committed, so its absence is a defect of the base); test_impact_closure
  pins a fixture tree without the file.
