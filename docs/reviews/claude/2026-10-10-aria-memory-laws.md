# ARIA — memory laws: the writer holds the append-only line on the whole self-learning record (2026-10-10)

Owner: claude (implementation), okan (review). Plan document:
`docs/reviews/claude/2026-10-02-aria-memory-retention.md` (measured evidence; two refutation
rounds distilled the hybrid design). This slice is B1a of the campaign.

## Context

The operator's binding requirements for ARIA memory: persistent, detailed, repo-shaped and
immutable — an append-only, hash-chained log whose past never changes. ARIA-HIGH-263 (cb9016a80)
closed the publish and snapshot ends of the road on main: `state_manifest.memory_surfaces()` is the
one derivation of "which ledgers are memory", compaction refuses those names, the snapshot builder
refuses a shrunken or rewritten-prefix memory claim (`snapshot_memory_surface_rewrite`), and the
publish gate refuses a continuity verdict of the same kind — not acknowledgeable.

Two holes remained on main's tip (9b52ad3cb):

1. **The protection covered 15 surfaces, the self-learning record is 47.** The 32 ledgers beyond
   the flagged set — judgment samples, operator feedback, feedback-consensus uncertainties, judge/
   adapter/recommendations calibration, goldset proposals, agent evals + fixtures, fitness reports
   and agent fitness, skill-genesis ×4, agent-genesis ×5, genesis sandbox runs and lifecycle
   events, plan convergence events, change planned/committed/validated/outcome, and the
   agent-invocation claims/results/transcripts/contexts/prompts record — were ordinary ledgers. A
   01f37e939-type manual reset ("reset ledgers to empty — hash chain starts fresh", 2026-08-31,
   which truncated beliefs 212 rows and observations 30 rows) is still a legal operation on them.
2. **Every gate fires after the tree is built.** The snapshot builder checks at snapshot time, the
   publish gate at publish time; nothing stands at the writer. The one function every rewrite of a
   declared ledger flows through (`ledger._rewrite_jsonl_unlocked`) would chain and store any rows
   it was handed, memory or not.

## Evidence

Measured on the state branch tip 05c5d3160 (2026-10-02), from the plan document:

- Compaction had archived 662 of the 700 memory rows ever recorded (350 beliefs → 8 live,
  350 learning events → 33; 17.7 MB gz, 94% in archives no memory reader opened). Fixed on main by
  ARIA-HIGH-263 (compaction refusal + shrink checks) for the 15 flagged surfaces.
- `f5bcb194d` (2026-08-31, manual "compaction — kept beliefs") emptied learning events and runs;
  `01f37e939` (manual reset) emptied beliefs (212 rows) and observations (30 rows, never archived —
  surviving only in git history at 523dd8c70).
- The next KERNEL publish (`executor-33604693287-1`, 2ca3ce533, 2026-09-02) continued snapshot
  `executor-33339827005-1` — which claimed `memory_beliefs` row*count 212 — and published
  row_count 0: `snapshot_continuity` reported the shrunk ledger as merely "changed" and the
  continuity gate judged only \_missing* surfaces. On 2026-09-04 the first cycle re-proposed 8
  beliefs from nothing (`first_seen_cycle` reset, `observation_count` 30→1, `support_count` 3→1).
- Rollover is not in tension with append-only: `append_segment_rows` +
  `_assert_segment_append_allowed` (ledger.py) append monthly segments and never rewrite, so a
  rewrite-time refusal cannot touch them (pinned by test in this change).

## Rule

Memory — everything ARIA and its agents observed, believed, judged, measured and decided about
their own work — is an append-only, hash-chained log whose past never changes. Nothing that
rewrites, collapses, prunes or truncates a memory-class ledger is admitted: not by the kernel's
writer, not by a migration, not by a publish. The memory set is the manifest's `memory` flag and
only that; no copy of the list exists anywhere else.

## Design (hybrid, per the plan's two refutation rounds)

Main's gate mechanics are the authority and are NOT duplicated here; B1a adds exactly the two
halves main lacks:

1. **Surface migration (declared once).** The self-learning ledgers gained `memory=True` in
   `state_manifest.STATE_SURFACES`. Single derivation: `memory_surfaces()` and every gate reading it
   (compaction refusal, snapshot shrink check + prefix witness, publish continuity verdict, and the
   new write-time refusal) extend at once. The union is 57 surfaces: the 15 main already flagged
   (6 `memory/*` + `memory_procedural`, 4 kg, `context_usage`, `kg_signers`, `reflections`), the 32
   tools-root ledgers of the first cut, the two MONTHLY invocation segment families, and the eight
   workspace `aria-memory/*` ledgers of the refutation round (both below). Two surfaces stay out ON
   PURPOSE because tests fake legacy rows in them by rewriting history
   (`test_compaction_attestation`, `test_state_publish_maintenance`, `test_judgment_bridge_e2e`,
   `test_agent_submit_result_e2e`): `tools_governance` and `agent_invocation_requests` (the frozen
   anchor; its monthly segments ARE flagged). No literal surface set is carried anywhere — the
   abandoned half-implementation's `MEMORY_CLASS_SURFACES` frozenset is not reproduced; the flag is
   the set.
   - **Monthly segments (refutation round, P1).** `agent_invocation_request_segments` and
     `agent_invocation_prompt_segments` are where the actual rows live; the frozen anchors are only
     segment 0. Flagging the anchors alone left every past month prunable — a live probe accepted
     `rewrite_declared_jsonl(prompts/2026-XX.jsonl, rows[:1], "prune")`, 4 rows → 1 on disk. Both
     segment families carry the flag now; the rollover's append path
     (`append_segment_rows` → `_append_rows_locked_body`) never rewrites, so it costs nothing
     (pinned by `test_a_monthly_segment_is_memory_and_cannot_be_pruned_or_emptied`).
   - **Workspace memory (refutation round, P1).** The eight `aria-memory/*` ledgers carried
     "memory" in their names and lock groups while staying outside the law — a live probe accepted
     a truncate of `workspace_memory_unknowns`, 3 rows → 1. Evidence per ledger (live workspace
     `00cc2f30056cf43a`, writers grep'd): `missed_signals` (63 rows, capability gaps ARIA failed to
     catch), `pressure` (63 rows, what drove investigation), `governance` (1,416 rows, the audit
     trail of actions on the workspace — history denial is the 01f37e939 class of loss), and
     `unknowns`/`external_feedback`/`pressure_state`/`vocabulary_rejections`/`since_migration_events`
     (append-only writers, empty on that workspace). Every writer appends
     (`feedback.append_jsonl`, `pressure.append_pressure_state_event`,
     `workspace.record_workspace_governance`); no test rewrites any of them. They are
     workspace-root, so the publish/snapshot gates never see them — the writer's law is the only
     gate they CAN have, which is why they carry the flag rather than a documented exclusion.
     `workspace_integrity_index` stays out: it is derived index data, rebuildable by definition.
2. **Write-time refusal (tier 1 — make it impossible).** New `aria_kernel/memory_class.py`:
   `refuse_history_rewrite(path, rows)` called from `ledger._rewrite_jsonl_unlocked` under the
   caller's locks, before a byte is written. A rewrite of a flagged surface must keep the content
   of every recorded row at its position (chain fields aside, which the writer recomputes):
   appends pass; a byte-idempotent restamp passes (same content → same hash → the existing chain
   survives byte-identical); the chain backfill of an unchained legacy file passes (what
   `_backfill` does); a collapse, a prune, an edit, a reorder or a truncation refuses with
   `memory_history_rewrite_refused`. A refused rewrite writes nothing. A torn trailing write
   (ORPHAN-CRITICAL-561) is excluded from the comparison, so crash recovery still heals.

Test fixtures that simulate a memory LOSS for the publish/snapshot gates (main's
`test_memory_not_compactable.py`) now write the bytes out of band
(`rewrite_declared_out_of_band`): the writer refuses to produce the loss — which is the point —
and the real losses (01f37e939, f5bcb194d) arrived as manual commits, never kernel calls.

## Fix

- `aria-kernel/aria_kernel/state_manifest.py` — `memory=True` on the 32 self-learning ledgers, the
  two monthly invocation segment families and the eight workspace `aria-memory/*` ledgers (57 in
  all); `memory_surfaces()` docstring names the write-time refusal and the two load-bearing
  exclusions.
- `aria-kernel/aria_kernel/memory_class.py` (new) — the write-time law; derives the set from the
  manifest flag, no restated list. The position-mismatch refusal names both shapes ("an edit or a
  reorder"), so the equal-count reorder — the backfill-launder shape no row-counting layer can
  see — says what it is.
- `aria-kernel/aria_kernel/ledger.py` — `_rewrite_jsonl_unlocked` calls `refuse_history_rewrite`
  first (local import: memory_class reads this module's hash/torn-tail primitives).
- `aria-kernel/tests/_helpers/declared_fixtures.py` — `rewrite_declared_out_of_band` for
  loss-simulation fixtures (also the shape the two e2e segment legacy-fakes now use).
- `aria-kernel/tests/test_memory_not_compactable.py` — the four loss fakes moved out of band; the
  seed helper resolves glob ledgers (`plan_convergence_events` is `plans/*.jsonl`) to one
  deterministic family file, and seeds the monthly-segment surfaces through the rollover's own
  `append_segment_rows` path (a bare append to a month file without its opener marker is refused by
  design).
- `aria-kernel/tests/test_judgment_bridge_e2e.py`,
  `aria-kernel/tests/test_agent_submit_result_e2e.py` — the request-segment legacy fakes moved out
  of band: the segments are memory now, and editing a recorded row is exactly what the writer
  refuses.
- `aria-kernel/tests/test_memory_retention.py` (new) — pins the B1a contract: the surface set (57,
  all declared ledgers, tools- or workspace-root, the two exclusions), the refusal (drop/edit/
  truncate/empty/reorder RED — including a monthly segment prune and a workspace-memory truncate,
  both the refutation round's live probes — restamp+append GREEN, refused rewrite writes nothing,
  glob family per-file, judgment-samples as a non-`memory/*` member), the unchained-legacy
  backlink pass, and monthly prompts segment rollover untouched.

## Not done

- **B1b — the archive reader and the repo-shaped index** (`memory_history.history_rows`,
  `memory_loci`, the `memory_loci_index` surface, reflection/burn-in whole-log counts): tracked as
  the next slice of the same campaign; the abandoned half-implementation's versions of those
  modules are the starting material.
- **`tools_governance` and `agent_invocation_requests` (the frozen anchors) cannot join the flag
  yet** — the tests that fake legacy rows in them by rewriting history must first write the legacy
  shape at append time. Until they do, a manual reset of those two ledgers passes the writer (the
  snapshot gates also do not see them: they are unflagged; their monthly SEGMENTS are flagged and
  protected). Pinned by
  `test_the_self_learning_record_is_memory_and_the_two_exceptions_stay_out`.
- **Out-of-band tampering is still possible by definition** — the writer's law binds only calls
  through the kernel's writer. The snapshot/publish gates (ARIA-HIGH-263) remain the backstop for
  bytes that changed outside; a tampered-then-backfilled memory file re-chains with its tampered
  content and passes the write gate (the backfill compares content, not history) — only the
  publish-time prefix witness against the published tip catches it.
- **Tampering before the FIRST publish is verified by no layer.** The prefix witness compares
  against the tip's prior claim; before the first snapshot exists there is no claim to compare
  against, and the writer's law binds only kernel-writer calls — so out-of-band edits to a memory
  ledger in a store that has never published are invisible to every gate (the write gate sees a
  plain rewrite of the file only if it flows through the writer; raw disk edits never do). The
  recovery source for that window is the state branch's git history, not a runtime check. Closing
  it would need a chain anchor established at bootstrap — tracked for B1b's archive reader, which
  is where reconstructed history first meets the log.
