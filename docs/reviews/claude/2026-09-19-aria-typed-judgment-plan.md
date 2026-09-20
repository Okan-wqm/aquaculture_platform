# ARIA typed, batched, calibratable judgment — plan and findings (2026-09-19)

Recorded 2026-09-19, rev 2. The judgment pipeline (evidence judge → adversarial judge →
consensus → anchor → suppression / promotion) is complete in code and produced 59 accepted results
in August; it has produced none since 2026-08-22 (101 judge requests minted in September, zero
results) until the first executor run after the chain restart (35444645590, 2026-09-19) folded the
first evidence judgments and released the adversarial judge every time (ARIA-HIGH-161). This
document plans a typed, batched, calibratable judgment layer — the structured-decision idea of
TypeSafe/Jev (`choice` / `score` / `noul` questions answered with a value, a probability
distribution and a confidence; the decision itself made by policy) — designed against the code as
it is. It was produced by three exploration passes, one design pass and three adversarial reviews
(performance and systems, security and containment, calibration statistics), and every number
below was read from `origin/aria/state` or the kernel source at `441fa8cd8`.

The operator's phrasing: "plan it by reading ARIA's existing code", "attack it with three hostile
agents from different disciplines and revise", "record the plan in a document".

## 1. What the reviews changed

- Phase 3 is not "run judges outside the sandbox". A `claude -p` spawn without containment inherits
  the host's real `~/.claude` (this host: `permissions.defaultMode: auto`, four plugins, session
  persistence under `~/.claude/projects/`), and `--disallowedTools` is a deny-list over a 12-name
  universe that does not name `Skill`, `EnterWorktree`, `Artifact` or `SendMessage`. Judges keep
  bwrap in a READ shape (workspace ro-bound, no write binds, no commit containment) and add
  `--restricted --permission-prompts none --tools <grant>`. The sandbox wrap is sub-second; the
  per-request floor is ~10 ledger transactions, three node start-ups and the model.
- Phase 4 is split: 4a extracts the inline blocks of `_main` into behaviour-preserving helpers; 4b
  adds the batch child. A K-request child is priced `2493 + K × 4440 s` (the single-child
  derivation is one claim, one CLI, one terminal write, one release), the fill stops at the first
  batch-key mismatch and never excludes, the breaker counts one failure per child, one cost row
  per call, item failures are request-fault and batch failures harness-fault.
- An evidence index alone makes every verdict look cited (the consensus fabrication detector
  grades only `missing | invalid`, and an index always resolves to a ref inside the request box).
  Every cited index carries a ≤120-character verbatim quote checked against the hash-pinned
  excerpt bytes. The model never writes `confidence_source`; the route stamps it, unconditionally.
- Anchor-grade ground truth is tautological for the judges that formed it (`judges_voted ==
judge_count`, and `score_judges` scores every vote in the group against the group's own
  consensus). Per judge, the truth set excludes anchor rows the judge observed. ECE at 10 bins and
  30 samples is at the noise floor (a perfectly calibrated judge under the live confidence
  distribution reads `uncalibrated` 32 % of the time at n = 30, 1 % at n = 100): `calibrated`
  needs n ≥ 100, a bootstrap upper bound and a Wilson lower bound; 30–99 is `provisional`.
- Under `enforce`, "uncalibrated judges vote but their confidence is excluded" let one calibrated
  confidence close a two-judge group (less conservative than `measure_only`). Closing authority is
  a calibrated quorum of two distinct models. Human labels are counted only when explicitly
  `source_type: human`, HMAC-verified and joined to a judge group; the label queue writes its own
  stratified sample because a judged finding is never re-sampled and a batch verdict outside a
  sample is refused.

## 2. Live numbers (origin/aria/state, 2026-09-19)

| Measure                                        | Value                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| pending judge requests                         | 315 evidence + 322 adversarial + 3 arbiter = **640**                                                                                               |
| accepted judge results (all time)              | 25 evidence + 32 adversarial + 2 arbiter = 59; none between 08-22 and 09-19                                                                        |
| `operator-feedback.jsonl`                      | 22 rows: 19 `ai_judge`, 3 `ai_consensus` (none anchor-grade), **0 human**                                                                          |
| fold gap 59 → 19                               | 27 pre-manifest publish loss (08-12/13 runs), 12 flat verdict shape, 1 arbiter uncertainty (still retried on the replay lane, 09-18), 5 duplicates |
| `calibration/judge-calibration.jsonl`          | 35 rows, 34 with `judges: []`, 1 with two judges at one sample                                                                                     |
| live judge confidences                         | 0.72–0.90 in three bins; TP mean 0.845 vs FP mean 0.861 (no separation)                                                                            |
| adversarial verdicts folded on `claude-opus-5` | 2 of 11 (ARIA-HIGH-161)                                                                                                                            |
| drain throughput (measured)                    | ~9 judgments per night (`genesis_policy.py:92–96`)                                                                                                 |

## 3. Facts in the code that shaped the design

- Verdicts ride in `details.verdict` (`judgment_bridge._verdict_field`, `validate_judge_response`);
  the executor's pre-submit gate covers `evidence_judgment` and `adversarial_judgment` only
  (`ci_executor._pre_submit_validate_envelope`) — the arbiter is not gated.
- Evidence excerpts are embedded at mint, hash-pinned (E17-b, `agent_invocations._evidence_excerpts_for_refs`);
  a rendered judge prompt averages 17.3 KB (~5k tokens) with no shared prefix between requests.
- Z.ai `json_object` is off for the legacy path (`ARIA_ZAI_JSON_OBJECT`; measured 2026-09-11: the
  model rewrote every evidence path); `run_zai_chat(json_object=…)` is a direct parameter. No
  `logprobs` anywhere: every confidence today is self-reported.
- `_settle` in the drain parses `dispatch_summary_path=` lines last-wins; the breaker records one
  failure per request; `_next_pending_for_role` passes `--role/--exclude` only and cannot filter
  `target_sha`; each call is a full ledger load (~30 s live).
- `agent_dispatch_model` is stamped from `agent_profile.model` under `if dispatch_model:`; the
  rung that actually ran (auth failover, `run_with_model_fallback`) is not on `ClaudeRunResult`.
- `observer_identity_missing` is emitted by `generate_ai_consensus` but absent from
  `CONSENSUS_UNCERTAINTY_REASONS` and `human_required.CONSENSUS_UNCERTAINTY_SEVERITY` — it never
  escalates. `record_operator_feedback_batch` writes `judgment_group_id = verdict.judgment_group_id
or sample_id` while judges use `judge:<tool>:<fingerprint>`; `judge_calibration._group_key`
  joins on `(run_id, finding_id, judgment_group_id)`.
- `load_feedback` reads rows without HMAC verification; `is_ground_truth_row` and
  `_build_ground_truth` default a missing `source_type` to `human`.
- `judge_weights_from_calibration` uses tp/fp regardless of `status`; the conformal floor is taken
  over every `ai_consensus` confidence, not the correct ones (`cycle.py:1793–1799`).
- `_sampleable_raw_findings` never re-samples a `(run_id, finding_id)` that has any feedback row;
  `record_operator_feedback_batch` refuses a verdict outside the sample's items; the sample's
  `status` is never persisted (`stored_sample` is built and dropped).
- Policy knobs merge only the keys named in `JUDGMENT_PIPELINE_DEFAULTS` (`genesis_policy.py:91–117`).
- 49 of 59 accepted judge results carry the legacy `judge:<tool>:<run>:<rule>:<path>:<line>` group.

## 4. Phases

Each phase is its own lane and pull request; the order is binding. Phase 0 → 1 → 2 → (observe the
first production executor drains) → 3 → 4a → 4b → 5 → 6 → 7.

### Phase 0 — measure and register (this document)

Findings ARIA-HIGH-162 … ARIA-MEDIUM-174 below; PR for ARIA-HIGH-160 opened (#1608);
ARIA-HIGH-161 fixed on its own lane. To pin in the same phase: the runner's `claude --version`
and the presence of `--restricted / --permission-prompts / --tools`; the wall-clock of the bwrap
wrap against the kernel-CLI floor.

### Phase 1 — `aria_kernel/typed_judgment.py` (pure, no I/O)

`PRIMITIVES = ("choice", "score", "noul")`, `CONFIDENCE_SOURCES = ("self_reported",
"provider_reported")`, closed `PARSE_REASON_CODES` (`payload_not_json`, `answers_not_list`,
`answer_missing`, `question_id_unknown`, `question_id_duplicate`, `primitive_mismatch`,
`value_not_in_options`, `value_out_of_scale`, `confidence_missing`,
`confidence_out_of_unit_interval`, `confidence_below_argmax`,
`confidence_probabilities_inconsistent`, `evidence_index_not_integer`,
`evidence_index_out_of_range`, `evidence_quote_mismatch`, `rationale_missing`,
`rationale_banned_phrase`). Frozen `ChoiceQuestion / ScoreQuestion / NoulQuestion`, `TypedAnswer`
(`question_id, primitive, value, probabilities, confidence, evidence: (index, quote)…, rationale`),
`ParseFailure`, `JudgmentBatch`, `BatchParseResult` with the invariant `answers ∪ failures ==
questions`. The answer schema does NOT contain `confidence_source`. Confidence contract (recorded
in `docs/aria/CONTRACTS.md`): `confidence := P(value is correct) = max(probabilities)` when
probabilities are present; `argmax ≠ value` or `|confidence − max| > 0.01` is a parse failure;
`confidence < 0.5` is a parse failure. `render_batch_system_turn` states that the typed answer
schema supersedes any per-question "Response" section; `render_batch_user_turn` fences each
question (`<question id=…>`) with its excerpts inside the fence; `materialize_evidence_refs`
checks each quote against the pinned excerpt bytes; `estimate_batch_input_tokens`. Tests:
round-trip per primitive, one subtest per reason code, a three-question batch with one malformed
item yields two answers and one failure, a cross-question contamination attempt yields
`question_id_unknown` with the neighbour untouched.

### Phase 2 — envelope mapping (closes ARIA-MEDIUM-166, ARIA-MEDIUM-170, ARIA-MEDIUM-171)

`judgment_bridge.typed_verdict_block`; `validate_judge_response` accepts legacy unchanged and
typed (`primitive == "choice"`, value in `FEEDBACK_VERDICTS`, confidence required, indices in
range, quotes in the pinned excerpts); the pre-submit gate covers every `JUDGE_ROLES` member.
`details.agent_confidence_source` is stamped unconditionally by the executor;
`provider_reported` is accepted only when the stamp says so AND `model_fleet` marks the stamped
model's provider confidence-native. `ClaudeRunResult` gains `model` (the rung that ran); both
stamps derive from it. `record_operator_feedback` gains `confidence_source` and
`evidence_selection` (additive, signed at write). The contract hash change is accepted alongside
the previous hash for one cycle. Both judge contract files carry a full Verdict Contract section;
`JUDGE-DIGEST.md` is regenerated.

### Phase 3 — read-contained judge spawn (closes ARIA-HIGH-162)

Eligibility: profile id in `{judge_opus, judge_glm, arbiter}` AND `tools ⊆ {Read, Grep, Glob}`
AND `mcp_servers == []`. `invoke_claude_cli` passes `skip_permissions=False,
read_containment=True`; `build_claude_exec_argv` adds `--restricted --permission-prompts none
--tools <grant>` (`--disallowedTools` stays as the belt); `_apply_read_containment` wraps with
`wrap_managed_claude_in_sandbox(write_scope=())` — workspace ro-bound, no commit containment, the
private HOME holding a symlink to `.credentials.json` so the OAuth refresh lands in the real file
(ARIA-HIGH-157); `CLAUDE_CONFIG_DIR` under the synthetic HOME; the hook broker stays;
`sanitize_journal_entry` records `path / glob` for Grep and Glob; `CLAUDE_TOOL_UNIVERSE` grows.
Governance row `claude_spawn_readonly{profile, argv_hash, config_dir}` per spawn. Tests pin the
argv, the config dir, the eligible set (exactly three profiles), an unchanged implementer spawn,
and deny-not-hang under `-p` with a fake CLI. No wall-clock claim.

### Phase 4a — extract the inline blocks of `_main`

`_claim_request_via_cli`, `_render_and_bind_prompt`, `_submit_via_cli`,
`_reconcile_native_result` (today inline blocks, moved verbatim); `_adaptive_pre_claim_admission`
split into `_admit_native_route` (once per batch) and `_bind_request_to_route` (per request, from
one ledger load and the batch form `derive_request_states`); `batch_worst_case_seconds(K)` is
`2493 + K × 4440`, equal to `_child_worst_case_seconds()` at K = 1 (golden). Drain-mode golden
test: governance rows and summaries byte-identical before and after.

### Phase 4b — batched judge child on the Z.ai route (closes ARIA-MEDIUM-163)

`ci_executor.py --judge-batch <role> <target_agent> <request_id>…` →
`ci_executor_judge_batch.run_judge_batch`; the drain selects K (`--target-agent` passed, batch key
`(role, target_agent, target_sha)`, stop at the first mismatch and never exclude, K bounded by
`judge_batch_size`, by `_max_requests() − len(attempted) − len(quota_pending)` and by
`floor((budget − elapsed − 2493 − 600) / 4440)`; every claim leased
`batch_worst_case_seconds(K)`). One `run_zai_chat(json_object=True)` per batch, the env gate
staying legacy-only; `judge_batch_max_input_tokens` (24 000) shrinks K; a `payload_not_json` or
`output_budget_exhausted` halves the next K. Per request: attempt reservation, a transcript
holding only that item's answer plus `batch_id` and the payload hash, envelope from
`TypedAnswer` fields only, pre-submit gate, submit, reconcile from one load, dispatch summary.
One cost row per call (`request_count`, `batch_id`); K attempt rows share `usage_ledger_hash` with
`usage_share`. Item failures release `judge_batch_item_unanswered:<code>` (request-fault, budget
burns); batch failures release `judge_batch_call_failed:<code>` (harness) with K refusal
summaries. `_settle` collects every summary line into `{request_id: summary}` and accounts per
request; breaker, circuit and streak (ARIA-HIGH-158/159) count once per child. Policy:
`judge_batch_size: 1` (opt-in), `judge_batch_runtimes: ["zai"]`. Target: adversarial judgments
per night ≥ 3 × the same role's pre-batch measurement inside the 30-request cap; the cap moves
only after that measurement.

### Phase 5 — Brier and ECE over judge-local ground truth (closes ARIA-HIGH-167, ARIA-HIGH-173)

Per judge J, the truth set is verified human rows ∪ anchor rows where J ∉ `observers`; the row
reports `n_human`, `n_anchor_external`, `n_anchor_self_excluded`. `brier_score`,
`brier_skill_score` (against the constant-accuracy baseline), `expected_calibration_error`
(fixed bins), `bootstrap_ece_upper` (seeded via `calibrated_intelligence.deterministic_seed`,
1000 resamples, 90 %), `wilson_lower`. `calibrated` ⇔ n ≥ 100 AND bootstrap upper ECE ≤ 0.10 AND
the Wilson 95 % lower bound of accuracy among verdicts at confidence ≥ 0.80 is ≥ 0.75; 30–99 is
`provisional`; per `(judge_id, model, confidence_source)`. `judge_weights_from_calibration`
returns the prior mean unless `calibrated`. The conformal floor is taken over human-verified
correct consensus rows only. Row `schema_version` 2; knobs in `JUDGMENT_PIPELINE_DEFAULTS`.
Existing `precision / recall / accuracy` stay bit-identical.

### Phase 6 — a suggestion, not a closer (closes ARIA-MEDIUM-164, ARIA-HIGH-165, ARIA-HIGH-169, ARIA-MEDIUM-174)

`calibration_gate: measure_only | enforce` (default `measure_only`); the accessor downgrades
`enforce` while fewer than two `calibrated` judges of distinct models exist (from the in-memory
`score_judges`), recording `calibration_gate{configured, effective, calibrated_judges,
distinct_models, reason}` on every cycle row and a doctor warning after seven days downgraded.
Under `enforce`, `generate_ai_consensus` closes only on `|agreeing ∩ calibrated| ≥ 2` with
distinct models, the mean taken over that set (`judge_count` is that set;
`calibration_basis{gate, excluded_judges}` on the row); an uncalibrated dissenter still produces
`judge_disagreement`. Gate order: dedupe → single_judge → judge_disagreement → agreeing →
calibrated_quorum → missing_confidence → low_confidence → conformal_abstain →
evidence_not_repo_verified → observer_identity_missing → row. `confidence_uncalibrated` (LOW) and
`observer_identity_missing` (HIGH) enter both vocabularies; `confidence_uncalibrated` feeds the
label queue first and HUMAN_REQUIRED at most `max_uncalibrated_escalations_per_cycle` (5). A
`score_judges` exception under `enforce` resolves to `confidence_uncalibrated`. `is_ground_truth_row`
is unchanged. Verified human label = explicit `source_type: human` AND
`verify_operator_feedback_row(...).valid` AND a `judgment_group_id` a judge group carries. The
label queue (`aria-kernel feedback label-queue`) writes its own judgment-sample row
(`strategy: calibration_stratified`; strata `escalated`, `auto_closed_random`, `pending_random`),
pre-fills `verdict: null`, requires `confirmed_by_operator: true`, records
`label_provenance{queue_id, stratum}`; `record_operator_feedback_batch` takes `judgment_group_id`
from the item and persists `stored_sample`. `calibrated` is decided on the random strata only.

### Phase 7 — provider `jev` (last; once the vendor API is verified)

`tools/aria-poc/jev_runtime.py` mirroring `zai_runtime` (`ARIA_JEV_API_KEY_FILE`, probe,
`run_jev_judgment` over a `JudgmentBatch`, confidence `provider_reported`); a fleet member with
`admits_writes=False, confidence_native=True`, `_RUNTIME_BINARIES["jev"] = None`, the admission
credential check generalised to `credential_file_env`, profile `judge_jev` and agent file. Its
contribution is cost and provider-reported confidence; anchor diversity is secondary (Z.ai and
OpenAI are already two vendors).

Verified against the vendor 2026-09-19: `POST /v1/systemone` answers a typed question with a value,
a probability distribution and a confidence derived from it, in about 1200 requests per minute,
and returns **no citation and no rationale**. ARIA's judge contract (an index and a quote checked
against the pinned excerpt) cannot be met by it alone, so the provider is not a judge: it is the
fast layer below the judges, and the table below is where each layer stands.

| Layer              | What answers                                                                                                | Where it acts                                                  | What it may decide                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 0 — rule reflex    | deterministic gates (schema, evidence refs, anchor, lease, hash chain, breaker)                             | every boundary                                                 | exact refusals; no model is asked                                               |
| 1 — learned reflex | `jev`, and the calibrated priors of `calibrated_intelligence` (tool, rule, path pattern → measured FP rate) | **before** fan-out as triage; **beside** consensus as a signal | orders the queue; flags disagreement; never closes, never suppresses on its own |
| 2 — deliberation   | the judges and planners (Claude, GLM) with citations                                                        | fan-out, consensus, planning                                   | the verdicts and plans that close                                               |

Layer 1 rows are `ai_judge` rows with `confidence_source: provider_reported` and
`evidence_selection: request` (the request's own refs, verified at mint; no citation of its own).
Its thresholds exist only while its `(judge, model, confidence_source)` stratum is `calibrated`
under Phase 5's rule; before that, and whenever the status is lost, it runs in shadow — answered,
scored, steering nothing. A suppression it proposes is a candidate for the label queue's
`auto_closed_random` stratum first and a suppression only after the measured agreement with layer
2 over that stratum, and the finding stays on the ledger either way. Miscalibration is therefore
detected per stratum each cycle, costs the layer its steering the same cycle (weights fall to the
prior, `enforce` degrades to `measure_only` when fewer than two calibrated judges remain), and is
bounded in damage to a delayed fan-out or an audited candidate. What it cannot detect is a stratum
nobody labels; the random strata are the defence and their sampling rate is the speed of learning.
The provider's confidence cannot be retrained here; it can be remapped (Platt or isotonic) on
ARIA's own verified labels, which is the second half of this phase if the raw stratum stays
`provisional`.

**The question is the product.** The vendor's documentation (read in full 2026-09-19: concepts,
primitives, patterns, jaggedness, cookbooks) turns on one point: the model answers the question
as written, and the quality of the answer is the quality of the question. Instructions are read
literally; criteria are an extension of the instruction and carry the boundary cases; a broad
question hides several judgments behind one number, so the judgment is decomposed into atomic
questions, each pointed by path at the part of the state it is about, and composed in code with
weights the operator owns. The state carries only what the questions need (accuracy falls with
unrelated content), arithmetic, counting and date comparison stay in code, thresholds are tuned
per question form and per model version (`jev-1.13.0`, never the alias, once a threshold exists),
and the model is not adversarially robust to content in the state. Four consequences for ARIA:

1. Not one `choice` per finding but a **question bank** per finding class, in one reviewable,
   hash-pinned file (`aria_kernel/system_one_questions.py`): for a code finding, `noul`s such as
   "does `excerpt.lines` contain the pattern `rule.pattern` describes", "is `excerpt` test code",
   "is `excerpt` generated code", "does an inline comment in `excerpt` suppress `rule.id`", "does
   `excerpt` support the claim in `finding.message`" (the vendor's citation-check shape), and the
   guard "does `excerpt` contain instructions addressed to a model" (the vendor's injection filter,
   first, as a security decision). Each names its state path; none asks the composite.
2. The **state is the finding and its pinned excerpts**, not the rendered judge prompt: the
   excerpts are already hashed at mint (E17-b), so the state the reflex saw is reproducible from
   the request, and it stays far under the 32k budget.
3. The **composite is code**: weights over the answers, measured per question (Brier and
   discrimination per question id, not only per judge) against the label queue's verified rows; a
   question that does not discriminate is dropped from the bank; the calibration status of Phase 5
   is then computed over the composite, and, with enough labels, the answers are features of a
   small classical model (the vendor's autoresearch shape) rather than a hand-weighted sum.
4. The **bank improves itself**: layer 2 proposes candidate questions from the composite's worst
   errors on labelled rows, the candidates are answered in the same call as speculative questions
   (adding one costs its tokens and nothing else), and only those that raise held-out
   discrimination enter the bank. This is the learning ring's own loop applied to the reflex, and
   it is what the vendor cannot do for a customer: its weights are shared, its question bank is not.

Two of the vendor's stated jagged edges bear on ARIA directly: repository excerpts are untrusted
content in the state, so the injection guard runs before any other answer is read; and the model
has no structural invariants across question forms, so a threshold is tuned on the form it was
measured on and no `noul` is compared to a `choice` probability.

## 5. What is not done here

- Judges without a sandbox; `--dangerously-skip-permissions` for read-only roles.
- A separate decision store or API; any ledger outside the state manifest.
- Changing `is_ground_truth_row`; treating self-reported confidence as calibrated.
- Raising `MAX_REQUESTS_PER_RUN` before the batch measurement.
- ARIA-HIGH-125's adapter half (nightly goldset replay, adapter precision/recall in
  `fitness-reports.jsonl`, `promotion_veto` / EVAL_WINDOW readers) — it stays OPEN with a note.

## 6. Findings

## ARIA-HIGH-162 — judges spawn with `--dangerously-skip-permissions` despite read-only profiles

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-10-03
- **Evidence:** `invoke_claude_cli` never passes `skip_permissions=False` or a `permission_mode`
  to `run_claude_exec` (`tools/aria-poc/ci_executor.py`, the call site under "Plan 032 Faz 032b"),
  so `_is_write_capable` reads True for `judge_opus`, `judge_glm` and `arbiter` (tools `Read,
Grep, Glob`, `write_scope: []`, `data/runtime_profiles.json`) and every judge takes
  `wrap_managed_claude_in_sandbox` with the write-capable binds, the hook broker and the commit
  containment derivation. The read-only argv shape exists (`claude_runtime.py`, "A read-only /
  preview turn passes `skip_permissions=False`") and has no caller. Removing containment instead
  is worse: the spawn env derives `CLAUDE_CONFIG_DIR` from the real HOME (`agent_env.py`), and the
  host's `settings.json` sets `permissions.defaultMode: auto`.
- **Rule:** a profile that cannot write spawns in a read shape: a positive tool allowlist,
  prompts denied by name, user settings ignored, the workspace bound read-only, no commit
  containment — and the row says so.
- **Plan:** Phase 3.

## ARIA-MEDIUM-163 — every process-less Z.ai judgment is one admission, one probe and one call

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-10-10
- **Evidence:** `_invoke_native_zai` makes one chat completion per claimed request with no
  process, no sandbox and no hook broker, yet the fleet probe (`probe_zai_status`, one
  `max_tokens=1` completion), the admission row and the request-ledger load repeat per request;
  the drain's summary channel and `_settle` are keyed one summary per launched child. 322
  adversarial judgments are pending against a measured ~9 per night.
- **Rule:** work that shares a route, an agent and an anchor shares one admission and one call;
  every request keeps its own claim, attempt, envelope, summary and cost share.
- **Plan:** Phase 4b.

## ARIA-MEDIUM-164 — `observer_identity_missing` is outside the closed vocabulary and never escalates

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-10-10
- **Evidence:** `generate_ai_consensus` emits it through `_consensus_uncertainty` (no vocabulary
  check) for an anchor-grade group whose observer has no `model`; it is absent from
  `CONSENSUS_UNCERTAINTY_REASONS` (`feedback_store.py`) and from
  `human_required.CONSENSUS_UNCERTAINTY_SEVERITY`, so the sweep records `benign_not_escalated`,
  and `record_consensus_uncertainty` would refuse it.
- **Rule:** every reason a consensus can end in is in one closed vocabulary that the severity map,
  the recorder and the sweep all read; the test that pins it walks the call sites.
- **Plan:** Phase 6.

## ARIA-HIGH-165 — operator batch labels never join the judge groups they label

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-10-03
- **Evidence:** `record_operator_feedback_batch` writes `judgment_group_id = verdict.get(
"judgment_group_id") or sample_id`; `judge_fanout._group_id` is `judge:{tool_id}:{fingerprint}`;
  `judge_calibration._group_key` joins on `(run_id, finding_id, judgment_group_id)`. A human row
  written through the documented batch lane therefore calibrates no judge. The sampler
  (`_sampleable_raw_findings`) also never re-samples a `(run_id, finding_id)` that carries any
  feedback row, and the batch lane refuses a verdict outside the sample's items — a judged finding
  has no sample a label can bind to. The sample's `status` is never persisted (`stored_sample` is
  built and dropped; 125 `pending` / 65 `empty` samples live).
- **Rule:** a human label lands on the exact group the judges voted on; the queue that asks for
  labels writes the sample it asks against.
- **Plan:** Phase 6.

## ARIA-MEDIUM-166 — the consensus arbiter is not pre-submit gated

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-10-10
- **Evidence:** `_pre_submit_validate_envelope` runs `judgment_bridge.validate_judge_response`
  for `evidence_judgment` and `adversarial_judgment` only; a `consensus_arbitration` envelope that
  cannot fold is sealed, accepted and fails in the bridge (the live `agent_bridge_warning` rows for
  one arbiter claim, retried again on 2026-09-18).
- **Rule:** every judge role's output contract is checked before the claim is sealed.
- **Plan:** Phase 2.

## ARIA-HIGH-167 — judge confidence has no Brier or ECE and no calibrated status

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-10-03
- **Evidence:** `judge_calibration.score_judges` reports precision, recall, accuracy and
  `mean_confidence_correct / wrong`; no Brier or ECE exists in the kernel; `generate_ai_consensus`
  closes a group when the mean self-reported confidence is ≥ 0.80 (`CONSENSUS_MIN_CONFIDENCE`);
  the live distribution (0.72–0.90, TP mean 0.845 vs FP mean 0.861) shows no separation. The
  confidence semantics are undefined in the judge contracts ("confidence: 0.0 to 1.0"), and
  `confidence_in_unit_interval` accepts 0.0–0.49 for a binary verdict.
- **Rule:** a confidence that closes findings is measured against ground truth with a scoring
  rule and a reliability estimate that state their sample size; until then it is a suggestion.
- **Plan:** Phases 1 (contract) and 5 (measurement).

## ARIA-MEDIUM-168 — 40 accepted judge results never folded, three causes

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-10-10
- **Evidence:** 59 accepted judge results on `origin/aria/state`, 19 `ai_judge` rows. 27 came
  from runs `gha-31562321582` and `gha-31711634581` (2026-08-12/13), before
  `operator-feedback.jsonl` joined the state manifest (first on `aria/state` 2026-08-17): written
  runner-locally and dropped by the publish. 12 carried the flat verdict shape refused before
  ORPHAN-HIGH-629. 1 arbiter uncertainty was refused before ORPHAN-CRITICAL-735 and its claim is
  still retried by the replay lane (`agent_bridge_warning` rows dated 2026-09-18). 5 are
  duplicates re-minted under the finding-keyed group. `bridge_status` on the result row is a
  mint-time constant and never updates.
- **Rule:** a claim whose fold is refused by a contract that will not change stops retrying by
  name; a result row's bridge status is the fold's status.
- **Plan:** the replay-lane stop and the `bridge_status` update are their own small lane after
  Phase 2; the first two causes are closed by history and recorded here.

## ARIA-HIGH-169 — human labels are counted, not verified; a missing `source_type` counts as human

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-10-03
- **Evidence:** `load_feedback` reads `operator-feedback.jsonl` through `load_jsonl` with no
  `verify_operator_feedback_row`; verification runs only in `operator_feedback_ingestion.py`.
  `is_ground_truth_row` and `judge_calibration._build_ground_truth` default `source_type or
"human"`. The HMAC key lives under the store and is readable by every executor process, and it
  attests "the kernel wrote this row", not "an operator did".
- **Rule:** a row that changes what closes or what calibrates is verified before it counts, and
  an absent provenance is not the strongest provenance.
- **Plan:** Phase 6.

## ARIA-MEDIUM-170 — a ref inside the request box passes the fabrication detector by construction

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-10-10
- **Evidence:** `validate_agent_response_evidence` checks `response.evidence_refs` and the
  satisfaction matrix against `request.evidence_refs ∪ allowed_scope`; `details.verdict.evidence_refs`
  are graded only by `_has_unverifiable_evidence` (`missing | invalid`). A judge that copies the
  request's own refs — or, in the typed layer, returns an index — is "evidence-backed" for every
  verdict; two judges citing the same request refs read as independent corroboration.
- **Rule:** a citation proves the judge read the bytes: a verbatim quote checked against the
  pinned excerpt, and rows record how the evidence was selected.
- **Plan:** Phases 1 and 2.

## ARIA-MEDIUM-171 — the dispatch-model stamp names the profile, not the rung that ran

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-10-10
- **Evidence:** `_build_envelope_from_claude_output` stamps `details["agent_dispatch_model"] =
dispatch_model` under `if dispatch_model:` with `agent_profile.model`; `run_with_model_fallback`
  may have run the cross-vendor rung (`AUTH_FAILOVER_TIER`), and `ClaudeRunResult` carries no
  model. ARIA-HIGH-161's live envelope reads `glm-5.3` for an attempt whose row says
  `claude_session_id`. The anchor grade's distinct-model count reads this stamp.
- **Rule:** the stamp names the model that answered, from the result, unconditionally.
- **Plan:** Phase 2.

## ARIA-MEDIUM-172 — the replay lane retries a claim whose fold is refused permanently

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-10-10
- **Evidence:** one arbiter claim refused with `judge_verdict.verdict:invalid:None` before
  ORPHAN-CRITICAL-735 carries three `agent_bridge_warning{kind: judge_bridge}` rows, two dated
  2026-09-18 — the replay lane re-runs the bridge on a payload the current contract accepts only
  when re-minted, and the accepted row never reaches `permanent_fail`.
- **Rule:** a bridge refusal that names a contract, not a transient, ends the retries by name.
- **Plan:** with ARIA-MEDIUM-168.

## ARIA-HIGH-173 — anchor ground truth is tautological for the judges that formed it

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-10-03
- **Evidence:** `is_ground_truth_row` requires `judges_voted == judge_count` (no dissenter);
  `score_judges` scores every `ai_judge` row in the group against the group's own consensus, so a
  judge in an anchor group is "correct" at whatever confidence it wrote. The live fleet is exactly
  the three judges an anchor needs; with 0 human labels a judge can reach `calibrated` on its own
  anchors. `judge_weights_from_calibration` uses tp/fp regardless of `status`, so three human FP
  labels give a judge weight 0.5 and its partner alone (0.8/1.3 = 0.615 > 0.6) closes a
  two-judge split with `judge_count = 1`. The conformal floor (`cycle.py:1793–1799`) is taken over
  every `ai_consensus` confidence, not the correct ones.
- **Rule:** a judge is scored against evidence it did not produce; an unmeasured judge weighs the
  prior; a floor is a floor over what was right.
- **Plan:** Phase 5.

## ARIA-MEDIUM-174 — `enforce` on a row count floods HUMAN_REQUIRED at the switch

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-10-10
- **Evidence:** a gate keyed on a global count of human rows (the first draft's 30) leaves every
  judge below its own per-judge minimum when the rows spread over three judges and two tools; every
  two-judge group then escalates, and `sweep_consensus_uncertainties_for_human_required` mints
  one record per group (322 judge groups live).
- **Rule:** enforcement waits for what it needs — two calibrated judges of distinct models — and
  labelling work goes to the label queue, not the escalation ledger.
- **Plan:** Phase 6.

## ARIA-MEDIUM-175 — a judgment is prose in an envelope; no typed question or answer exists

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-10-03
- **Evidence:** every judge role is minted as a prose prompt (`judge_fanout._render_prompt`:
  "Return verdict true_positive|false_positive with file:line evidence") and answered as a free-text
  envelope whose verdict is extracted by `_extract_envelope_json` (fenced blocks, last wins, then a
  balanced-brace scan) and read by `judgment_bridge._verdict_field` in three spellings. No schema
  states what a question is, what an answer is, what `confidence` means, or how N judgments could
  share one call; the kernel has no primitive to ask a model a closed question and refuse a
  malformed reply by name.
- **Rule:** a judgment is a typed question with a typed answer — a closed primitive, a schema, a
  stated confidence semantics, a citation the parser can check, and a failure vocabulary — before
  it is a prompt.
- **Plan:** Phase 1 (`aria_kernel/typed_judgment.py`).

## ARIA-HIGH-176 — the planner dispatch hook serves the child from the cycle's shared checkout

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-26
- **Evidence:** `planner_dispatch_hook.dispatch_one_pending_planner_request` ran `ci_executor.py`
  with `cwd=repo_root` and `ARIA_WORKSPACE_ROOT=repo_root` — the checkout the cycle stands in,
  which is `main`. Under `managed_subscription` the native admission binds `request.target_sha` to
  that checkout's `HEAD` (`_native_task_binding_refusal`), and `main` advances hourly on this
  repository, so every planner request minted before the last advance is refused
  `target_revision_mismatch`, released harness-class, and asked again next tick. Measured
  2026-09-19: `AIR-aria-challenger-planner-2d16fdbb749e` (anchored at 09-18's `b8febe123`) was
  refused forty times from `HEAD 254d1ef7cb`; no convergence, no implementation behind it. The
  drain has served each request from `aria-worktrees/req-<id>` at its anchor since ARIA-HIGH-124 —
  in its own private helpers, which the hook could not reuse.
- **Rule:** a request is served from a tree at its own anchor by every caller that starts a child;
  the per-request worktree bracket is one kernel spelling, not the drain's private one.
- **Fix (this lane):** `aria_kernel/request_worktree.py` holds the bracket (bounded git, leftover
  reconcile, refused vs unanswered as two receipts); `ci_executor_drain` delegates to it; the hook
  adds the worktree at `request_anchor_sha(request)` before the child, runs the child there, and
  removes it after. A git that refuses (an unknown sha) falls back to the shared checkout as before;
  a git that does not answer starts no child, releases the lease `native_runtime_control_unavailable`
  and returns `provider_control_unavailable`, on which the daemon already backs off.
- **Proof:** `tests/test_planner_dispatch_worktree.py` — the child's `cwd`/`ARIA_WORKSPACE_ROOT`
  is the worktree and its `HEAD` is the anchor while the shared checkout's `HEAD` has moved; refused
  → shared checkout; unanswered → no child, lease released, request PENDING, exact governance
  sequence; no anchor → shared checkout as before.

## ARIA-MEDIUM-177 — the drain's exit code reads harness health and agent quality as one colour

- **Severity:** MEDIUM · **Owner:** claude · **Deadline:** 2026-10-03
- **Evidence:** `ci_executor_drain.drain_pending` returned `0 if failed == 0 else 1`, and `failed`
  counted every child summary whose outcome was `failed`, whatever its `failure_class`. The child's
  closed vocabulary separates the host's conditions (`harness_unavailable`, `timeout`,
  `auth_failed`, `credit_exhausted`, `process_exit`, the drain's own `child_without_summary`) from
  the request's own (`policy_violation` — a contract the pre-submit gate refused;
  `response_schema_rejected` — a result the kernel rejected and recorded as REJECTED on the
  request's ledger). Run 35444645590 dispatched thirty, folded twenty-seven and was red for one
  judge that cited a line range (`agent_evidence_ref_malformed`); the nightly signal an operator
  reads as "the harness broke" carried an agent's own mistake, already recorded where it belongs.
- **Rule:** an exit code reports whose failure it is. The harness's condition is red. A request's
  rejected output is counted, detailed and warned by name, and reddens the run only when such
  failures dominate it — every agent failing the same way is the contract's condition, and that
  share is the floor of red, not the ceiling of green.
- **Fix (this lane):** `drain_exit_code(attempted, succeeded, harness_failed, request_failed)` as
  the one rule (1 on any harness failure; 1 when request failures reach `REQUEST_FAULT_RED_SHARE`
  = 0.5 of the attempted or are the only outcome; 0 otherwise); both halves on the
  `executor_drain_completed` row and in `GITHUB_OUTPUT` (`drain_harness_failed`,
  `drain_request_failed`); a `::warning` annotation per request-class failure so the run page
  names it without opening the log.
- **Proof:** `test_executor_drain_mode.DrainExitCodeNamesWhoseFailureItIs` — the rule by table
  (the live 30/27/1 case green; one harness failure red; half the attempted red; the only outcome
  red), a rejected result among successes green with both halves recorded and the annotation
  written, a contract violation as the only outcome red.

## ARIA-HIGH-179 — a resumed session never finds its transcript

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-27
- **Evidence:** executor run 35471772861 (2026-09-19 22:02Z), request
  `AIR-aria-challenger-planner-2d16fdbb749e`: the session ledger matched the fingerprint and the
  journal showed progress, so `decide_session` returned `--resume 10c31c16-…`; the CLI's transcript
  is one row, `error_during_execution`, `num_turns 0`, `errors: ["No conversation found with
session ID: 10c31c16-…"]`, exit 1 → `provider_nonzero` → claim released
  `native_runtime_execution_unavailable`, `requeue_count 1`. The cause is structural:
  `wrap_managed_claude_in_sandbox` gives every spawn a tmpfs HOME (`SANDBOX_HOME`) and sets
  `CLAUDE_CONFIG_DIR` inside it; the CLI writes the conversation under
  `<config>/projects/<cwd>/<session>.jsonl`, and the tmpfs is gone with the process. Only the
  credential file is bound in. Every request whose first attempt made progress without finishing —
  a planner by construction — resumes into nothing, forever, as a harness-class release that burns
  no budget and produces no plan.
- **Rule:** a session is resumed only where its transcript will be found; the transcript outlives
  the spawn in a durable store the sandbox binds at the private config dir, and the resume decision
  reads that store.
- **Fix:** `session_continuity.session_store_dir()` (`$ARIA_SESSION_STORE_DIR`, else
  `~/.config/aria/sessions` of the executor's user — outside every checkout),
  `transcript_present(session_id, store_dir)`, `decide_session(store_dir=)` resumes only when the
  transcript is present (no store → never); `wrap_managed_claude_in_sandbox(session_store_dir=)`
  creates `<store>/projects` and binds it writable at `<private config>/projects` after the tmpfs,
  refusing a store inside the workspace by name; both containment shapes (`claude_runtime`) and the
  executor's `_decide_session_and_recovery` pass the same store.
- **Proof:** `tests/invariants/v12/test_phase_v12_c_session_recovery.py` (I-V12-SESS-02 now:
  progress and fingerprint without a transcript → fresh; with the transcript in the store → resume;
  no store → never; the store's resolution order; the executor and the runtime hand the same store
  to both decisions) and `tests/test_managed_claude_sandbox.py` (the store's `projects` bound
  writable at the private config dir after the tmpfs; nothing bound without a store; a store inside
  the workspace refused).

## ARIA-HIGH-180 — the native paths released a paid verdict over a cost row they could not write

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-27
- **Evidence:** executor run 35485712865 (main `0239eecc8`, 2026-09-20 03:29Z), request
  `AIR-aria-adversarial-judge-8281c4e19fd1`: routed `zai/glm-5.3` (ARIA-HIGH-161 holds),
  `runtime_attempt_finished` with `exit_code 200` and `result_admission
control_or_transport_unavailable`, the envelope written with the verdict, the claim requeued
  `native_runtime_execution_unavailable` at `requeue_count 0`. The request row carries
  `convergence_id: null`, as every request the judge fan-out mints does. The Z.ai path (and the
  Codex path beside it) passed `request["convergence_id"]` straight to `record_cost_attribution`,
  whose `plan_id must be a non-empty string` is a `GovernanceError` the attempt catches as
  `control_or_transport_unavailable` — after the vendor was paid and the verdict parsed. The
  Claude path always derived `plan-<request tail>` for the same request. A harness-class release
  burns no budget, so the request would be judged and discarded on every run.
- **Rule:** a cost row's identity is derived once, the same way on every runtime path; a request
  minted without a convergence is attributed to `plan-<request tail>`; a paid verdict is never
  released over bookkeeping it cannot fail.
- **Fix:** `ci_executor._cost_identity(request, request_id)` — the Claude path's derivation
  extracted — used by the Z.ai, Codex and batch paths.
- **Proof:** `tests/test_ci_executor_native_zai.py` — a judge request minted with no convergence,
  through the real executor and the fixture vendor: `ACCEPTED`, one attempt admitted
  `pending_native_submit`, no requeue, one cost row with `plan_id plan-<tail>` (red before the
  fix: the attempt was released and the state stayed PENDING).

## ARIA-HIGH-182 — a successful native dispatch said nothing to the drain

- **Severity:** HIGH · **Owner:** claude · **Deadline:** 2026-09-27
- **Evidence:** executor run 35509466473 (main `f7ae92d48`, 2026-09-20 12:02–14:50Z), the first
  drain with ARIA-HIGH-180 on main: `results.jsonl` gained 26 accepted adversarial judgments and
  the state branch published them; `executor_drain_completed` said `attempted 30, succeeded 1,
failed 26, harness_failed 26, failure_counts {child_without_summary: 26}` and the workflow went
  red. The Claude CLI path emits its `succeeded` summary inside `invoke_claude_cli`; the native
  runtimes (`_invoke_native_zai`, `_invoke_native_codex`, `_invoke_native_claude`) return 0 from
  `_main` after `_reconcile_native_result` with no summary at all, and the native non-zero exit arm
  releases the claim without one. The drain's rule (B8) is that the summary is the only evidence of
  success, so the yield the night produced read as the night's failure — the mirror of the
  false green B8 closed.
- **Rule:** every terminal path of a dispatch writes its one classified summary, and the summary
  names the route that ran (the admitted provider and model), never the profile's declared pair.
- **Fix:** `_main` writes a `succeeded` summary after the native reconcile and a `failed`
  `harness_unavailable` (retryable) summary on the native non-zero exit arm; both on
  `_native_route_for_summary` — the admitted route — because the evidence judge declares
  `anthropic/opus` and is admitted on `zai/glm-5.3`, and the drain keys its circuits by the pair
  that answered.
- **Proof:** `tests/test_ci_executor_native_zai.py` — the real executor process against the
  fixture vendor writes `dispatch-result-<id>.json` with `outcome succeeded`, `provider zai`,
  `model glm-5.3`, no failure class, and publishes its path on `GITHUB_OUTPUT` (red before the
  fix: no file; red with the declared route: `anthropic/opus`).
