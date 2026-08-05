# ARIA Wave 1 §2.3 — the `aria/state` store: an ancestry proof that is about bytes

Date: 2026-08-03
Branch: `claude/aria-w1-state-store`
Scope: `aria-kernel/aria_kernel/state_store.py`, `cli.py` (`state checkout|publish|verify-store`)
Plan: `docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md` — Wave 1, PR 2.3

## What was already true

`state_snapshot` (PR 2.2, merged as `db4d937f`) gave ARIA a `manifest_root`:
one hash over the whole surface map, chained to its predecessor through
`prev_manifest_root`, which sits inside the hashed payload. That closed
ORPHAN-HIGH-528 — the absence of a tree-level continuity root.

It had no consumer. This PR spends it.

## The finding it answers, in three registered forms

- **ORPHAN-CRITICAL-484** — a lane could publish a bootstrap-empty tree
  under the canonical `aria-tools-state` artifact name, burying the other
  lane's queue with no automated recovery.
- **ORPHAN-CRITICAL-488** — the gate added for 484 made a genuine first
  run impossible: a newborn tree could never publish, permanently.
- **ORPHAN-CRITICAL-513** — the 484/488 fix lived in two hand-copied
  workflow heredocs and only the consumer lane's copy carried it, so the
  producer lane kept the hole.

513 was answered once already, by extracting one composite restore
action (`.github/actions/restore-aria-tools-state`). That was correct and
it stays. What extraction could not change is the KIND of proof available
at that layer.

`restored=true` is a claim about a STEP: the download exited zero. It
says nothing about the bytes on disk at publish time. A tree emptied
between restore and publish still satisfies it, and an empty tree passes
`integrity verify` because an empty tree is trivially consistent. The
gate could only ever be as strong as its evidence, and a workflow output
is the wrong kind of evidence for a claim about state.

## What this PR changes

`publish_state` refuses unless the snapshot being published names the
CURRENT published snapshot as its parent:

```
snapshot.prev_manifest_root == <remote-tracking tip>:snapshot.json.manifest_root
```

Three properties make that a real proof rather than a restated flag:

1. **It is about content.** `prev_manifest_root` is inside the hashed
   payload, so a snapshot edited to name a different parent gets a
   different `manifest_root` and fails its own self-check first.
2. **The anchor is the PUBLISHED commit, not the working tree and not
   local HEAD.** A caller that could rewrite `snapshot.json` on disk could
   choose what it is compared against, so the value is read out of a
   commit; and a local commit is not a publication, so the commit read is
   the remote-tracking tip. Anchoring on HEAD was a livelock — see the
   review section below.
3. **The check is inside the function, not at the callsite.** Both lanes
   and the operator CLI reach the branch only through `publish_state`.
   513's failure mode was not "someone forgot to copy the check" — it was
   that the check was ever copyable.

FF-only is not a flag this module sets. It is what a plain `git push`
already is: the server rejects a non-fast-forward update. The module's
contribution is never reaching for the escape hatch, held by
`ForceIsNotReachable`, which walks the AST and asserts the single `push`
callsite carries no force flag. A text scan would have been wrong here —
`--force` is legitimate on `worktree add`/`worktree remove`, which the
store uses deliberately.

Bootstrap is never inferred. The branch existing IS the proof that
bootstrap already happened; creating it requires
`ARIA_STATE_BOOTSTRAP_ACK` to name the repository out loud. So a deleted
branch does not silently re-bootstrap — it refuses, naming the value to
set. That is 484's intent expressed at a layer that can hold it, and 488
stays closed because "newborn" is derived from the published anchor
carrying `GENESIS` and no snapshot — tested with `cat-file -e`, so an
empty or unreadable blob is a damaged store rather than a first run.

## A dead seam from #1052, closed here

`build_daily_anchor` gained a `state_snapshot_path` parameter in PR 2.2
and nothing ever passed it — `emit_anchor_to_path` did not forward it and
the CLI did not compute it. A capability with no caller is the single
most repeated finding in ARIA's own audit history, and it is a
particularly poor one to leave in the daily anchor, which is the
committed record that stands in for git history.

Both levels now forward, and the CLI DERIVES the path rather than adding
a flag: if the store is checked out, its published `manifest_root` goes
into the anchor; if it is not, there is nothing to pin. An operator
deciding this per run is an operator who can forget.

## Surface growth is now measured (PLAN §2.2b's replacement needs it)

`.seg-NNN` ledger rollover is superseded — see PLAN §2.2b. Its
replacement is a MEASURED archival trigger, and a trigger needs a series
to fire on. Nothing in ARIA recorded surface size at all: the question
"is any surface approaching a size that matters" had no answer short of
someone going and looking, which is how a threshold gets crossed
unnoticed.

Every snapshot surface entry now carries `size_bytes`. The walk was
already visiting each file to hash it, so the measurement is free; what
it buys is that the trigger has something real to read when it is built.

To be exact about the fail-open hazard that killed rollover: it is NOT a
present defect. `_assert_raw_jsonl_append_allowed` returns when
`surface_for_path` yields `None`, and today that correctly means "this
path is not a governed surface". It becomes fail-OPEN only once segment
files exist — a `.seg-001` would hold governed state while matching no
declared pattern, so the append guard would wave it through. The hazard
is a property of the proposed design, not of the code as it stands, and
the finding says so rather than claiming a live hole.

## Six defects found while building it, and what each cost

These were found by tests, a smoke run, and a mutation check — not by
reading the code afterwards.

**1. A shared local branch turned a race into a silent chain.**
The first version checked the state branch out as a branch. Git refuses
the same branch in two worktrees, so the code forced it — which means
every store in one repository shares one ref. Two lanes racing on the
same runner would then CHAIN: the second commits on top of the first and
fast-forwards cleanly. The compare-and-swap silently does not happen,
which is worse than the race it exists to catch. Fixed by checking out
DETACHED; each store's HEAD moves alone and the only shared ref is the
remote's, where the server arbitrates. The race test failed until this
was fixed — it was written to fail for the right reason.

**2. Re-checkout discarded a cycle's unpublished writes.**
ARIA's producer lane runs on a persistent self-hosted runner, so a store
directory surviving between calls is ordinary. The first version removed
and re-added the worktree unconditionally, which deletes exactly the
ledger rows a cycle just wrote — ORPHAN-CRITICAL-484's loss coming back
in through the door marked "setup". Now: a clean worktree is replaced
(nothing to lose), one with uncommitted paths REFUSES and says how many,
and a directory that is not a worktree of this repository refuses as
unknown provenance.

**3. The daily anchor could not pin the store** — see the section above;
the parameter existed, nothing reached it.

**4. `publish` could never publish anything.**
Because publish began by re-checking-out, and re-checkout refuses over
uncommitted writes, the command refused on the very rows it was called to
persist. Found by running the CLI end-to-end rather than by reading it.
Fixed by splitting the two operations, which have opposite obligations:
`checkout_state_store` establishes the store at the tip and must refuse
over uncommitted writes; `open_state_store` attaches at the END of a run,
when those writes are the entire point.

**5. The store's add takes `--force`, but my justification for it was wrong.**
I claimed the main checkout's `.gitignore` reaches into the store. It
does not: git reads no `.gitignore` above a worktree's top level, and the
store's top level is `store_dir`, whose tree carries none. The
adversarial review checked this repository's real configuration —
`.git/info/exclude` holds only git's default comment template,
`core.excludesFile` is unset — and refuted the claim.

The `--force` stays, on a sound justification instead: the store commits
exactly the surface set the snapshot attests, and the two ignore sources
that CAN reach a worktree from outside its own tree
(`$GIT_COMMON_DIR/info/exclude`, `core.excludesFile`) are shared with the
main checkout, so a pattern added there for the main tree would silently
subtract a subtree here. The test now plants the rule in
`info/exclude` — the real mechanism — rather than asserting a premise
that does not hold.

Worth naming the reasoning error: I mutation-checked this test and
treated that as proof the defect was real. It was not. The mutation
proved the test exercises the `--force`; it said nothing about whether
the condition the test itself manufactures ever occurs.

**6. `extra_paths` was a parameter with no caller** — my own, in the same
PR whose review criticises exactly that. Deleted.

## Adversarial review before shipping, and what it found

The module is a data-integrity gate whose failure mode is "verifies clean
while carrying nothing", so it went through a six-lens review — silent
data loss, concurrency and the CAS, ancestry bypass, failure
classification, test quality, dead code — with every finding then sent to
a verifier instructed to refute by default. 23 findings, 10 verified, 7
confirmed and 3 refuted.

**CRITICAL — the re-checkout guard tested COMMITTED, not PUBLISHED.**
Four lenses converged here, and the verifier reproduced it end to end.
`publish_state` commits before it pushes because git requires it, so the
loser of a compare-and-swap — the DESIGNED outcome for one lane of every
contended cycle — ended up holding a commit reachable from nothing but
its worktree, with a perfectly clean `git status`. `_clear_existing_store`
read that as "every byte is committed, so replacing it loses nothing" and
deleted the commit along with its reflog. The next snapshot chained
cleanly to the rolled-back tip and `verify_state_store` answered valid.

Underneath it was a livelock the finders had not asked about:
`read_published_snapshot` read local HEAD, so after a rejected push the
loser's own commit BECAME its idea of "what is published". Every retry
re-chained to itself, passed the ancestry check and was rejected again —
permanently unpushable, with the only escape being the re-checkout that
destroys the work. My refusal message told the operator to "re-read the
tip and replay"; the only API for that was the function that deletes it.

Three fixes, at three different depths:

- `publish_state` rolls its commit back (`reset --soft`) when the push
  fails, so the rows return to the uncommitted state the store already
  refuses to discard, and the orphan is never manufactured.
- The publication anchor is the remote-tracking ref, not HEAD. Published
  means the remote has it; nothing local votes.
- `_clear_existing_store` refuses when HEAD is not contained in the
  remote — belt-and-braces for any writer that is not `publish_state`.

**CRITICAL — a zero-length `snapshot.json` read as "newborn".**
`git show` returns the empty string for three different facts: the path
is absent, the command failed, and the path is present but empty.
Collapsing them meant a truncated snapshot switched the ancestry check
off entirely — the one state in which any tree may publish over the
accumulated state. Presence now comes from `cat-file -e`'s exit status,
and an empty blob is a damaged store.

**HIGH — the fetch refspec had no `+` and its outcome was discarded.**
A rejected or failed fetch left the store established on a stale
remote-tracking ref with no error, which on a persistent runner means
building on last night's tip. The refspec is forced, and the tracking ref
is now checked against the SHA `ls-remote` already reported.

**MEDIUM — the dirty probe and the staging spoke different vocabularies.**
`git status --porcelain` omits ignored paths; `git add --all --force`
stages them. Both now use `--ignored`.

**Also removed:** `--no-push`. A "rehearsal" that commits without pushing
manufactures exactly the state the guard exists to refuse, and it had no
caller.

**Refuted, and I accept all three.** Two were the gitignore premise above.
The third claimed `publish_state` never re-derives the snapshot from the
tree it commits — mechanically true, but it names the wrong gate
(ancestry was never evaded; the missing property is a binding between the
attested map and the staged bytes), and the only production caller builds
the snapshot one statement earlier from the same tree with no intervening
I/O. Reaching it needs a new caller that bypasses the sanctioned builder
— an actor that already holds push credentials and needs no help from
this module.

Every fix above is mutation-checked: reverting it individually makes the
suite fail. Two fixes initially survived their mutation, which is how the
missing tests for the containment guard and the write-denial split were
found.

## Verification

- `aria-kernel/tests/test_state_store.py` — 33 tests over REAL git
  repositories (bare remote + working clone). The behaviour under test IS
  git's fast-forward rule plus what this module refuses around it; a
  mocked `git push` returning whatever the test wants would assert the
  test's own opinion.
- End-to-end CLI lifecycle: bootstrap → publish → checkout → publish
  (`linked: true`, `status: ok`) → `verify-store` clean, with the remote
  branch showing genesis + two chained state commits.
- Kernel suite and `invariants:fast` run sequentially, both green.

## What is NOT closed by this PR

ORPHAN-CRITICAL-484/488/513 stay OPEN. The mechanism is complete and
tested, but the lanes still travel through the artifact transport: the
`aria/state` branch does not exist yet, and creating it is a deliberate
one-time operator action (`ARIA_STATE_BOOTSTRAP_ACK`), by design — a
bootstrap that ARIA could perform for itself is a bootstrap that can
happen by accident, which is the finding.

Closing them requires the lane cutover (PR 2.4-2.6: workspace + findings
redirection, the `state_continuity` phase, and removal of the silent
bootstrap path in `aria-auto-cycle.yml`), and that in turn needs the
`[self-hosted, linux, claude]` runner back online — it has been offline
since 2026-07-17, so the producer lane has not run at all.

## Findings

- **ORPHAN-HIGH-531** — the tree-level continuity root had no consumer.
  CLOSED by this PR: `publish_state` is the consumer, and the daily anchor
  now receives the derived snapshot path through both levels.
- **ORPHAN-MEDIUM-532** — segment rollover superseded; the measured
  archival trigger's CONSUMER does not exist yet. Stays OPEN; `size_bytes`
  lands here so the trigger has a series to read when it is built.
- **ORPHAN-CRITICAL-484 / 488 / 513** — stay OPEN, per the section above.

Owner: okan · Deadlines unchanged (2026-08-25 for 484/488, 2026-08-14 for 513)
