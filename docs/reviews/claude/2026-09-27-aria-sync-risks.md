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
