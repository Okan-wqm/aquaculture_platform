# ARIA Wave 1 — the state snapshot: a continuity root above the files (2026-08-03)

Program: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md`, Wave 1
PR 2.2 (Revision-2 order — durable state before missions).

## ORPHAN-HIGH-528 — nothing above the files, so amnesia read as a fresh start

Every ledger ARIA writes carries a per-file sha256 chain, and
`integrity verify` (since PR 2.1) walks all ~129 declared tools-root
ledger surfaces. That makes any single file tamper-evident. What has
never existed is a root ABOVE the files: no artefact said "these
surfaces, at these hashes, are one coherent state, and they follow
THAT state".

The consequence is the failure mode the whole durable-state wave exists
for: when the 30-day CI artifact expires — or a workspace root dies with
its runner, which happens every run today — the next cycle starts on an
empty tree and every check still passes. Each surviving file verifies;
the tree just has less in it. "Fresh bootstrap" and "we lost everything"
are the same observation, which is the same defect class as
ORPHAN-CRITICAL-498 (a control that cannot distinguish two states it
must act differently on), one level up from the files.

The closest existing artefact, the daily anchor's
`integrity_index_chain_root`, hashes only the ~9-name index-group map —
it is a witness for a fraction of the tree and says nothing about
surface-level presence.

**Fix (this commit):**

- `state_snapshot.build_snapshot` walks `state_manifest` and records each
  present surface's identity (path, sha256, `segments`, and for ledgers
  `row_count` + `tail_ledger_hash`), then folds the whole map into a
  single `manifest_root`.
- **Storage policy IS the manifest's `state_class`** — no second
  inventory: `ledger`/`index`/`runtime_state` are `carried`, `artifact`
  is `artifact_only` (sha256 pinned, bytes stay cache-borne, so loss is
  detectable without inflating the store), `lock` is excluded. An
  unclassified future class raises rather than falling silently out of
  every snapshot, and a test asserts the manifest declares no class the
  policy lacks.
- Snapshots **chain**: `prev_snapshot_id` + `prev_manifest_root` sit
  INSIDE the hashed payload, so a continuous-looking history cannot be
  assembled by re-pointing genuine snapshots at different parents.
- `snapshot_continuity` names what a per-file check cannot see:
  `surfaces_lost` (a surface the predecessor had), `chain_broken`, or
  `genesis` — genesis being stated rather than implied, since "first
  ever" and "lost the link" must not look alike.
- `sign_snapshot` / `verify_snapshot_signature` use the per-cycle ed25519
  identity `gh_token_factory.mint_signing_key` already mints, via
  `ssh-keygen -Y` under a dedicated namespace (`aria-state-snapshot`) so
  a commit signature by the same key cannot pass as a snapshot
  attestation. Signing **refuses** when `ssh-keygen` is absent instead of
  emitting an unsigned manifest that reads as signed, and verification
  reports signature validity AND manifest-root validity as one answer —
  a valid signature over a manifest whose root no longer matches proves
  only that someone signed something once.
- Reachability, so the primitive is not another written-yet-uncalled
  control: `aria-kernel state snapshot` / `state verify-snapshot` (the
  operator path) and the daily anchor, which now carries
  `state_snapshot_id` + `state_manifest_root` — committing the root to
  git puts a witness outside the store the root describes.

**What this PR deliberately does NOT claim.** The cycle does not build a
snapshot automatically yet, and nothing yet refuses to publish over a
tree whose ancestry is unproven. Those are PR 2.3's job (`state_store`:
the `aria/state` branch, `publish_state` with FF-only CAS), and they are
where `ORPHAN-CRITICAL-484` and `ORPHAN-CRITICAL-513` — "a publisher can
bury accumulated state under a bootstrap-empty tree" — get their
structural fix: `prev_manifest_root` is exactly the positive ancestry
proof those findings demand. This PR builds that proof; it does not yet
enforce it. Both stay OPEN, unchanged, and are named here so the
sequencing is on the record instead of implied.

**Scope note:** PLAN.md bundles segment rollover into this PR. It ships
separately (next PR in the wave) because it changes the ledger append
hot path, which is an independent risk from an additive read-only
primitive — the same "independently landable" rule the plan sets for
Wave 0. No content is dropped; the snapshot schema already carries the
`segments` list a rollover populates, so the follow-up needs no schema
change.

Two properties in this list came from the repo's own invariants catching
mistakes in the first draft, and both made the design better: the CLI
briefly exposed a `--lane` flag (Plan ARIA-V3 §2c locks the lane as
kernel-derived — it is now derived from the entry point, so an operator
cannot label their run as a scheduled one), and the ledger tail was read
by a hand-rolled parse that skipped malformed rows. The second is now
routed through the kernel's one strict reader
(`load_jsonl_verified`), and a ledger that fails verification is
recorded as `chain_valid: false` with NO counts rather than plausible
ones — attesting a tip for a chain that does not verify would testify to
a state that never existed.

**Validation:** 17 tests (`aria-kernel/tests/test_state_snapshot.py`).
14 run everywhere: policy completeness against the live manifest, lock
exclusion, root-kind scope recording, root-reacts-to-content and to the
predecessor link, forged-parent rejection, lost-surface reporting, the
amnesic-tree case (a fresh root cannot reproduce its predecessor's root),
genesis naming, broken-chain recording, both signing refusals, and
the two anchor cases. 3 are
the real `ssh-keygen` round trip — sign→verify, tamper→fail, and a
foreign-namespace signature rejected — which skip only where the binary
is genuinely absent (this dev container) and run in CI.

Owner: aria-acceptance-gap-fixer. Deadline: 2026-08-10 (post-merge close
ceremony).
