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
