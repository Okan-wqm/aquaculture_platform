# main GitHub Actions health (2026-10-04)

Context: six workflows had a red latest run on `main` on 2026-10-04 (aria-readiness-claim, Scheduled
Workflow Watchdog, Deploy Capacity Maintenance, ARIA External Watchdog, CI - Full, Database WAL
Archive Freshness). Each latest failed run was read with `gh run view <id> --log-failed`; this file
records the repository defects found among them. The red runs that are correct alarms on an
operational condition are not findings here and are not silenced.

Owner: claude (implementation), okan (review). Deadline 2026-10-11.

## ARIA-HIGH-348

Evidence (at `main@690470509`):

- Run 37221868753 (PR #1779, 17:47Z): `aria_kernel.tool_registry.GovernanceError:
dlp_diff_surface_incomplete: files touched by d38b25979f82 absent from the scanned diff:
['.github/workflows/aria-auto-cycle.yml', ...]`. 37 of the lane's 44 failures on 2026-10-04 end
  in this error (PRs #1335, #1435-#1444, #1731-#1781); the other 7 reach the branch-protection gate
  and are rejected there (a correct alarm, see the operator section of the hand-off report).
- `.github/workflows/aria-readiness-claim.yml:169-170` — the `diff` DLP surface was
  `gh api repos/.../compare/<base>...<head> --jq '.files[].patch // empty' > compare.patch || true`.
  The compare API's per-file `patch` field is the hunk body only: no `diff --git a/<path> b/<path>`
  header, and no field at all for a binary or oversized file. `|| true` turned an API failure into
  an empty file.
- `aria-kernel/aria_kernel/readiness_proofs.py:1259` — `produce_dlp_proof` derives the touched set
  with `git show --name-only <head_sha>` in the workspace; `:1271` — it requires each touched path to
  appear in the scanned diff text; `:1274` — otherwise it raises `dlp_diff_surface_incomplete`.
  A path therefore reached the scanned text only when the file's own content spelled it, so the
  lane could not produce a claim for an ordinary PR.

Fix: the kernel builds the surface (`aria_kernel/readiness_diff_surface.py`,
`readiness build-diff-surface`) with `git diff <base>...<head>` from the same object store the scope
check reads, so the scanned text and the touched set come from one source. Full object ids only;
an unresolvable commit fails closed before anything is written. The lane calls it and the `|| true`
is gone. Tests: `aria-kernel/tests/test_readiness_diff_surface.py`.
