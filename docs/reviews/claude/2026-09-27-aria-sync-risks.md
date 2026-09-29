# ARIA — synchronisation and chain-restart risks (2026-09-27)

Context: on 2026-09-27 the operator asked for ARIA to be brought level between GitHub and the
production host, for its risks to be removed, and for its chains to be restarted only once each ring
is proven. Eight read-only surveys and four adversarial reviews of the resulting plan found that the
nightly chain has been red since 2026-09-21 and that one cause sits on the critical path of every
restart: the state-maintenance lane cannot publish, and after #1676 no cycle can either. The
`aria-auto-cycle` and `aria-agent-executor` workflows are disabled until the ring proofs pass
(operator decision, 2026-09-27 15:18Z).

Owner: claude (implementation), okan (review, operator steps).

## ARIA-HIGH-239

The raw-findings collapse (ARIA-HIGH-185, 8028bbb005, 2026-09-21) keeps only the newest row per
(tool_id, finding_fingerprint). A run whose findings all recur in a newer run lost every raw row,
and for a run whose hot artifact an earlier compaction had already pruned nothing reached its
findings any more. `verify_runtime_artifacts` refuses exactly that shape (`raw_pointer_missing`,
`runtime_artifacts.py:926-928`), `integrity.py` turns it into `runtime_artifact_invalid`, and the
maintenance lane's verify step refuses the publish. The kernel's own compaction produced a tree the
kernel's own verifier refused.

Evidence:

- `aria-state-maintenance` runs 35648185798 (09-21) to 36263043814 (09-26) all fail at "the
  compacted aria/state tree did not pass integrity verification"; the last success is 35528250156
  (09-20). The first bad change is the code, not the data. Run 36342600156 (09-27 18:58Z, main
  f2778c904, after #1676 landed as bd8d2c6f5) fails the same way.
- e93280b187 changed the attestation fixture to distinct fingerprints, which removed the one shape
  that would have caught the defect; no test covered `raw_pointer_missing`.
- Reproduced with the real kernel of #1676's head (e22bbe9f9) on `origin/aria/state` 1939ce19b:
  `integrity verify` is valid before `state compact --retain-days 7` and invalid after, with 55
  `raw_pointer_missing`.
- #1676 (merged 2026-09-27 as bd8d2c6f5; its `aria-kernel/` tree equals e22bbe9f9) does not change
  the collapse or the check, and it adds publish-time compaction
  (`state_store._bound_publish_surfaces`, over a 32 MiB trigger) followed by
  `_refuse_unverified_runtime_artifacts`. With raw-findings at 66.9 MB, every cycle publish would be
  compacted and then refused.

Rule: A compaction must not produce a tree its own verifier refuses: every run that reports raw
findings keeps a pointer to them after the collapse.

Fix: `state_compact._collapse_survivors` keeps, for every run the fingerprint collapse would empty,
that run's newest row. The verifier is unchanged. The collapsed copies go to the raw-findings archive
as before. On the same data the fixed compactor leaves a verified tree: 0 issues, raw-findings
66.9 MB / 40,361 rows to 13.4 MB / 8,259 rows (8,199 fingerprints plus 60 per-run rows across 80
runs).

## ARIA-HIGH-240

No lane that runs before a merge compacts the real `aria/state`. `aria-kernel.yml` runs the kernel
suite over fixtures only, so a kernel change that breaks compaction on the real tree merges green and
is first exercised by the next scheduled `aria-state-maintenance` run on main. ARIA-HIGH-185's
compaction change (8028bbb005, 2026-09-21) did exactly that and produced trees the kernel's own
`integrity verify` refuses (ARIA-HIGH-239). The maintenance lane then stayed red from 2026-09-21 to
2026-09-29, and publish-time compaction would have refused every cycle publish in the same way.

Evidence:

- `aria-state-maintenance` was red on every run from 35648185798 (09-21) until #1687 landed. The
  kernel lane was green on 8028bbb005 and on every PR in between.
- Reproduced on the live tip `d61dc79e5` (2026-09-29), through the restore action's binding
  (`state checkout` layout + `integrity bind-tools-root` + the four `ARIA_*` roots):
  `state compact --retain-days 7` with the kernel from before HIGH-239's fix (62fb94b66) leaves
  `integrity verify` invalid with 60 `raw_pointer_missing`. With main's kernel (dae95efb3) it is valid,
  with 0 issues.
- On maintenance run 36527583572 the whole path costs under 20 s: restore 4 s, compact 8 s,
  verify 6 s.

Rule: A kernel change that the maintenance lane would turn into an unpublishable tree must fail
before it merges, on the real state and not only on fixtures.

Fix: `aria-kernel.yml` gains a `state` job. It restores the live tip through the one restore action,
read-only (`contents: read`, no bootstrap-ack), then runs the maintenance lane's own compact and
verify steps with the change's kernel. It publishes nothing and fails when the verdict is not
valid. The lane's `aria-kernel` verdict job requires it. `aria-kernel/tests/test_state_compaction_gate.py`
pins the two steps to the maintenance lane's byte for byte (name, id, env, run), so the gate cannot
drift from the path it stands in for.

## ARIA-HIGH-241

The claim gate and the native task binding disagree about a request that names no anchor.
`agent_invocations._anchor_refusal_reason` follows ORPHAN-CRITICAL-495 (11 of 17 mint paths pass no
`target_sha`, and a missing anchor is not grounds for refusal), so such a request is claimable. But
`ci_executor._native_task_binding_refusal` refused the same row as `target_revision_unavailable`
(`elif not head.ok or not anchor`), and both managed-subscription call sites act on that refusal: the
single-request path (`ci_executor.py:4106`) and the judge batch (`ci_executor_judge_batch.py:243`,
which refuses every member with rows[0]'s anchor). The refusal is released harness-class, so every
unanchored judge request burned drain budget and was re-queued without running. The 2026-09-27 audit
counted 103 such rows and 27 `harness_failed` per drain.

Rule: A request the claim gate admits is bound, not refused, by the executor. When the request names no
anchor, the executor binds it at the observed HEAD and records that choice.

Fix: the binding treats a missing anchor the way the claim gate does. It binds at the HEAD the probe
observed, refuses only on a mismatch against an anchor that exists, and records the choice as
`runtime_task_bound` with `anchor_source="observed_head"`. `test_ci_executor_live_path_smoke`
mints an unanchored judge request with the kernel's own mint and runs the executor's native entry on
real git. The binding holds and the fleet refuses by its own name. Without the fix the same test fails
on the `runtime_task_binding_unavailable` row.

## ARIA-HIGH-242

The judge and arbiter contracts named their verdict values in hand-written prose, and the arbiter's
was wrong in three ways. It told the model to "emit an `uncertainty` result", a value
`judgment_bridge.validate_judge_response` accepts nowhere. It put the reason at
`details.uncertainty_reason`, a path the bridge never reads (the bridge reads the verdict block:
`details.verdict` or `details.consensus`). And it listed three reasons out of the eight in
`feedback_store.CONSENSUS_UNCERTAINTY_REASONS`. The live arbiter obeyed, and every such answer was
refused as `judge_verdict.verdict:invalid:'uncertainty'`: six per drain in the 2026-09-27 audit. The
same wording sat in `docs/aria/PIPELINES.md` (and so in the generated `JUDGE-DIGEST.md`) and in
the fan-out prompt (`judge_fanout`). The validator's own rules were already rendered from code into
every delivered agent contract (`render_response_validator_contract`), but the judge verdict law
was not part of that rendering.

Rule: A judge reads the verdict law the bridge enforces, rendered from the tuples the check uses.
No agent file carries a hand-written copy of the vocabulary.

Fix: `judgment_bridge.render_judge_verdict_rules` renders the roles, both verdict-block paths,
`FEEDBACK_VERDICTS`, and the arbiter's one non-verdict answer (omit `verdict`, set
`uncertainty_reason` from `CONSENSUS_UNCERTAINTY_REASONS`). The delivered contract carries it as a
section. The arbiter file, `PIPELINES.md`, the digest and the fan-out prompt point at it instead of
restating it. `test_judge_verdict_contract_delivery` pins four things: that the delivered text
carries every role, verdict and reason; that each judge agent receives it; that the answer it
describes passes the bridge for every reason while the old shape is refused; and that no judge
agent file names a reason.

## ARIA-HIGH-243

`autonomy_orchestrator._drain_next_cycle_queue` resolves a queue item's evidence refs from the item's
source: a mission's accumulated refs, or the stored payload of a pressure. When the source has none,
the mint fell back to `evidence_refs = [qid]`, the queue marker `qi-<hex>`. That contradicts the rule
stated a few lines above it, that refs come from the source record and never from the identifier.
The planner's contract (`aria-autonomy-planner.md`) is to read only the envelope's `evidence_refs`
and to cite them on blocked or contradicted rows, so it echoed the marker back.
`evidence_validator` then refused every such answer as `agent_evidence_path_missing` (the
2026-09-27 audit's D6). Two tests pinned the fallback as intended behaviour.

Rule: The queue marker never enters the evidence channel, and a request whose evidence cannot exist
is never minted.

Fix: a kernel-owned mission contract mints with the refs its source holds, which may be none. The
self-change contract asks the answer to establish its own `details.evidence_paths`. The generic
projection has only the refs resolved from its source. If it has none, the drain consumes the item
and writes `next_cycle_queue_item_unevidenced` (queue item, pressure, source cycle) instead of
minting. The item is queued again once its source holds evidence: a mission when its own work
records refs (its wake condition), a pressure when a cycle stores its payload. The two pinning tests
now assert that nothing is minted and the item is disclosed. The mission and generic-contract tests
mint with the mission's real refs, and the self-change test asserts an empty ref list instead of the
marker. Without the fix the new assertions fail.

## ARIA-HIGH-245

Found while landing ARIA-HIGH-243. `mission.open_mission` takes no evidence refs. The producers
derive each mission's contract from evidence they hold. `cycle._service_hardening_contract` builds
the next action and wake key from `finding:<id>`, `pressure:<id>` or `changed_path:<path>`,
`mission.adopt_task_candidates` builds them from `<source>:<source_id>`, and `gateway/router` builds
them from the issue. None of them records that evidence on the mission row. A mission gains refs
only through `mission_reconcile` (`pr:N`, `branch:X`), which happens after planning. Before
ARIA-HIGH-243 these missions minted with the queue marker, and every answer that cited it was
refused. After ARIA-HIGH-243 the drain consumes them as `next_cycle_queue_item_unevidenced`. Either
way, the charter's mission line never reaches the autonomy planner. This does not block chain
closure: C4 plans from `plan_synthesizer` candidates, which do not read the next-cycle queue.

Rule: A mission carries the evidence its opening contract names. A producer that can name its
evidence records it, and no mission line is unplannable by construction.

Fix direction (owner claude, deadline 2026-10-13): each producer resolves its source to refs when it
opens the mission (the finding's evidence paths, the pressure's stored `evidence_paths`, the changed
path, the issue URL), and `open_mission` records them. A producer that cannot resolve any refuses by
name.
