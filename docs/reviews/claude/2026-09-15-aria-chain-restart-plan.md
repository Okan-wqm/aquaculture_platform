# ARIA chain restart plan — after the 2026-09-15 session collapse

Recorded 2026-09-15. The four-day operator session that was closing the live chain (12,303
messages) went silent at 06:31Z; the host was hard-reset at 11:43Z (`/tmp` wiped, the self-hosted
runner left inactive and disabled). This document is the restart plan: what survived on disk, why
the session died, what is still between us and "the chain is closed", and the order of work sized
to the droplet (4 vCPU, 16 GB, shared with production). It was produced by three exploration, three
planning and three adversarial-review passes; every claim below carries the file or ledger it was
read from. The operator's phrasing: "plan for the level of the droplet we are on, put the fast work
first, and remember we were closing the chain".

## 1. Why the session died — and why the two ring-3 runs died with it

Not host exhaustion. `sar` for 05:40–06:30Z: 10.5–11.9 GB free, swap 100 % used but static
(`pswpin/s` ≈ 0), `sda` 39–102 MB/s of pure reads at 48–96 % utilisation, `pgsteal/s` 9,740 →
25,645 with `pgscank/s` = 0, `majflt/s` 335 → 815, load 24–27 with `runq-sz` 1–2 and 21–23 tasks
blocked. That signature is one cgroup reclaiming its own page cache and re-faulting it from disk:
**`user-0.slice` — every interactive session — thrashing against its own
`MemoryHigh=2816M / MemoryMax=3G`**
(`/etc/systemd/system/user-.slice.d/50-aria-memory-discipline.conf`). The Claude process, its
pytest children, the ring-3 `autonomy run` and the Claude CLI agents it spawned were all charged
to that one 3 GB budget. The runner was idle (no job between 05:15Z and 07:57Z). The second ring-3
run (00:50–03:49Z) showed the same picture at 01:10Z (`%iowait` 81, 11 GB free): both deadline
cuts were the slice, not the deadline. Turning the runner off removes a contributor, not the cause.
On the idle host after the reset the slice was already at 2.94 GB with ~260 `memory.high` events
per minute — 1.4 GB of it `ext4_inode_cache` from tree walks (a remote IDE's repository scanner,
`git status --untracked-files=all` across 96 worktrees, `find`/`du`).

Consequences for every step below: heavy work runs in its own slice (§4), the watchdog lives
outside the interactive slice and fires on reclaim pressure before the disk saturates, and each
block starts from a fresh session with the plan file and memory as the resume mechanism.

## 2. What is on disk (verified)

### 2.1 HIGH-124 lane — `/var/aqua-saas/.worktrees/aria-lane-124`

Branch `lane/aria-high-124`, HEAD `5072864525`. It is a fork of the candidate at `228e6c37b3`;
its two commits were re-committed on the candidate as `7aa6e2ff31` / `f7f4481740` with different
trees, so **rebase is wrong; the lane's uncommitted diff is ported as a patch**. 69 uncommitted
files (+9,863 / −1,031; eight intent-added): `implementation_delivery.py` (new),
`mcp_broker.py`, `mcp_relay.py`, `delivery_credentials.py`, `gh_token_factory.py`,
`git_containment.py`, `tools/aria-poc/ci_executor.py`, 31 test modules,
`.github/workflows/aria-agent-executor.yml`, `docs/aria/CONTRACTS.md`, the implementer prompt and
safety contract. `git apply --check` of the patch against the candidate exits 0 (disjoint hunks,
offsets only). Backup: `/root/aria-lab/lane124-r6.patch` (sha256 recorded beside it).

Round 5 verdict: three round-4 defects closed, one `must_fix` left — the delivery credential
(GitHub App token, one-hour life) was minted before the spawn and first consumed up to ~4 h later,
after the contained gate. Round 6 applied five fixes (a `credential` stage entered after the apply
gate and bracketing exactly push + PR open; revoke under the lease's own token; kernel git with
`core.hooksPath=/dev/null`; a diff secret scan before the suite; a stale credential-directory
sweep). Round-6 reverify was interrupted: green so far — `test_implementation_delivery` (29), two
batches (82, 228), `test_sandbox_and_perimeter_hardening` (29), `test_executor_pr_via_kernel`
(10), the real-bwrap e2e as `gharunner` 20/20. Never finished — `tests/test_pr_manager_e2e.py`
(36 tests; `timeout 590` killed it four times at load 10–18, single tests take 6–68 s; on a quiet
host it is a 3–8 min module). Never run — `test_managed_claude_sandbox`,
`test_ci_executor_live_path_smoke`, `test_git_containment`, `test_containment_probe`,
`test_signing_agent`, `test_autonomy_orchestrator`, `test_claude_runtime_contract`,
`*command_policy*`, the nine workflow-reading modules, the gates, the fails-before proofs.

Round 6 left the executor drain start window at 57 s (was 137 s). On this runner (state restore
alone measured 17 min) that window is routinely exceeded, the night ends with a healthy-looking
`executor_drain_window_skip` row and ring 4 is never attempted. It does not ship as is: three
literals in one commit (`ARIA_DRAIN_BUDGET_SECONDS` 20400 → 21000, `timeout-minutes` 500 → 510,
`JOB_TIMEOUT_MINUTES`, the pinned comment literals, `workflow_contract_registry.py:337`, the
CONTRACTS sentence), after the reproduction (`time … next-pending` over ~40 s).

The lane's registry row for ARIA-HIGH-124 sits on a dead chain (the candidate re-stitched the rows
below 121 in `d64388012f`); the finding enters the candidate only through `add-explicit`, and the
tool refuses the id while the lane worktree still holds it (sibling-worktree scan,
`tools/gates/finding-registry.ts:176-205`). The reservation ledger does not block 124 < 141
(`:421-422`).

### 2.2 Candidate — `/var/aqua-saas/.worktrees/aria-connected-candidate`

Branch `aria/connected-candidate-20260911`, HEAD `d88fca4602` = origin, PR #1553. Uncommitted
(03:45–04:33Z on 09-15), parked in `git stash` until block 2:

- **The ARIA-HIGH-140 fix** — `cycle.py` (`closeout` phases run past the deadline and outside the
  alarm; `fixture_refresh` asks the clock between suites and records
  `fixture_refresh_deadline_skipped`; `_first_interrupted_phase`; a tri-state integrity verdict),
  `cycle_runtime_status.py` (`phase_interrupted` → `failed`; only `integrity_valid is False` →
  `integrity_failed`), `autonomy_orchestrator.py` (the `phases` ledger in the bounded summary).
  **No test pins any of it.**
- **The hosted-CI fixes** for four of the five failure groups of run 34910051620 (§2.3):
  `implementation_safety._interpreter_ro_binds` with its pin, `contract_digest._normalise_table_row`
  with the regenerated `JUDGE-DIGEST.md`, `doctor_scoped_to("deadlines")` in
  `test_self_improvement_remedy.py`, the OpenSSH wording regex in `test_signing_agent.py`.
- Registry: rows ARIA-HIGH-140 (`findings.jsonl:2034`) and ARIA-HIGH-141 (`:2035`); review
  sections §140 and §141 in `2026-09-12-aria-live-chain-blockers.md`; no §124 yet (it lives in
  the lane's superseded commit at `:1117-1145`). The debt-plan `registry_tip_hash` still pins 139.

**Disclosure.** ARIA-HIGH-141 was appended and staged during the planning pass, by a planning
subagent that had shell access, at 15:28:52Z — a write that plan mode should not have made. The
row is correct (title, five evidence paths, review file, deadline 2026-09-22) and is kept; the
append order is therefore 140 → 141 → 124.

### 2.3 PR #1553 kernel lane (hosted ubuntu-22.04, run 34910051620)

6,594 tests in 4,946 s, 20 failures + 3 errors, five root causes:

| Group | Tests | Cause                                                                                                                                                  | Fix on disk                                                   |
| ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| A     | 15    | bwrap does not bind the hosted `/opt/hostedtoolcache` interpreter; fixture CLIs die at `execvp`                                                        | yes — `_interpreter_ro_binds` + pin                           |
| B     | 4     | `JUDGE-DIGEST.md` stale: Prettier padded the marked CONTRACTS table, render 10,556 B > 10,240 B cap; the droplet pre-push never selects `docs/aria/**` | yes — `_normalise_table_row` + regen                          |
| C     | 2     | git 2.55 creates `packed-refs.lock` in the read-only common dir (ARIA-HIGH-141; droplet git 2.43 never asks)                                           | **no**                                                        |
| D     | 1     | the real doctor reports `claude_cli` / `providers` failures on a hosted runner                                                                         | yes — `doctor_scoped_to`                                      |
| E     | 1     | OpenSSH 8.9 says `Load key …: No such file or directory`, 9.6 says `No private key found`                                                              | `test_signing_agent.py` yes; `test_git_containment.py:404` no |

The unittest half alone took 82 min of the lane's 110-min budget; the pytest half has never run
hosted. `aria-kernel` is not a required check on `main` (required: `sens-enterprise-summary`,
`merge-gate`, `aria-merge-authority`, `build-status`); "no merge on a red kernel lane" is policy.

**HIGH-141 as written overstates.** The positive real-bwrap tests (a signed commit lands inside
the sandbox) passed on hosted; the two reds are negative tests whose stderr now starts with
`error: Unable to create '…/packed-refs.lock': Read-only file system` — git ≥ 2.46 takes the
packed-refs lock for a pseudoref deletion after `git switch -c`, ignores the failure, but prints
it, and `containment_probe._failure_detail` keeps only the first and last line, so the real cause
line is dropped. The class is real (a deletion path that does not ignore the failure would die); the
exposure today is stderr noise plus the probe masking. It is on the path to a green PR-3, not on
the path to the live chain on the droplet. Fix shape (tier 1, `git_containment.py:247`): `--tmpfs`
over the common dir, then every existing top-level entry except `worktrees` and `*.lock` re-bound
read-only one by one — the lock is creatable and dies with the spawn, `packed-refs` stays a
read-only mountpoint (a rename onto it fails `EBUSY`), nothing reaches the host; the probe records
`git --version` and keeps every `error:`/`fatal:` line. Provable on git 2.43: `touch
<common>/packed-refs.lock` succeeds inside, `mv` onto `packed-refs` fails.

### 2.4 Trial eleven store — `/root/aria-planner-trials/trial-eleven-20260912`

- The CONVERGED plan `flow-083f26574cade7dee7fc` (`web/shell/src/hooks/useNotifications.ts`
  marks a notification read without reading the mutation result; two files, five specs) is the
  chosen external task zero (ARIA-HIGH-137). **`autonomy run` does not adopt it**:
  `plan_convergence.TERMINAL_STATES` contains `CONVERGED` (`:73`), `resume_candidate_plan_id`
  walks only active plans (`:960`), the store's `active-plans-cache.json` is `[]`. A completed cycle
  would synthesise a new plan from pressure sources and open new planning dispatches. No CLI verb
  requests implementation for an existing CONVERGED plan (`request_implementation`, `:1089`, has
  no caller).
- Where the two 09-15 runs spent their time: tool phase 62 / 139 min (the doc-staleness adapter's
  2,642-row raw-findings append took 28 / 79 min — O(n) on a 14 MB hash-chained ledger; three
  adapters hit their deterministic budgets for 25 min), then the deadline inside `fixture_refresh`.
  The 140 fix labels this honestly; it shortens nothing. The quietest data point (09-12): tool
  phase 31 min, judgment reached at 34 min; the planner drain, genesis, memory hook, baseline
  validation and specialist review come after that. A realistic budget is ≥ 4 h.
- Backlog: 75 unclaimed requests (60 judge rows expiring 09-19, 12 adjudication panels, two
  maintenance, one verification). No `role=implementation` row exists. A targeted
  `ci_executor.py <request_id>` skips the backlog. An implementation request unanswered for 24 h
  is reaped to `IMPLEMENTATION_REJECTED` by the next cycle (`plan_convergence.py:828`): no cycle
  runs between the mint and the executor.
- `nx.json` `defaultBase` is `main`, and the shared repository's local `main` ref is from
  2026-08-21 (`052d706d94`): `nx affected` sees 2,725 files, so the baseline suite (ring 3,
  `apply_engine.py:731`, 45-min timeout) and the apply gate (ring 4, `:952`) both time out and
  `_regression_status` reports `no_regression` on zero evidence. No worktree has `main` checked
  out; `git branch -f main origin/main` fixes it.
- Credentials: GitHub App Mode A does not exist on this host (only as Actions secrets). The
  self-hosted executor already runs Mode B (`GH_TOKEN="$ARIA_GH_TOKEN"` from the runner `.env`,
  `pat_fallback`, revoke a no-op). The PR therefore opens under the operator's PAT identity —
  the production path, not a manual repair — and the evidence records `mode: pat_fallback`. The
  ring-3 script strips every `ARIA_*` variable, so Z.ai never reaches a cycle
  (`ARIA_ZAI_API_KEY_FILE` joins the keep list). Two `claude` binaries: `/root/.local/bin`
  2.1.272, `/usr/local/bin` 2.1.233 — transient units get the former on `PATH`.
- **Ring 4 cannot run from the trial harness as the code stands.** The in-sandbox hook client and
  MCP relay are located by path from the workspace (`claude_runtime.py:948,1044`
  `kernel_root = <workspace>/aria-kernel`; `claude_settings.py:66-97`;
  `mcp_client.py:37,164,214`); the trial workspace `task-source@6652139901` has no
  `hook_client.py`, `mcp_relay.py`, `git_containment.py`, `hook_broker.py`, so hooks and MCP fail
  silently. `ci_executor._REPO_ROOT` defaults to the executor's own tree (`:455`), so publication
  would target the candidate. This is the first real instance of ARIA-HIGH-133 (the kernel lives
  inside the repository it operates on) and becomes ARIA-HIGH-142 (§5, block 5).
- The agent contract is rendered from the checkout at `target_sha`, so 124's prompt and contract
  changes are not exercised by this run; the `aria-impl-*` branch is behind `main`, so the merge
  needs "Update branch" (a merge commit not authored in the sandbox; `required_status_checks.strict`
  and `enforce_admins` are on, no review required). Both are recorded under §137 as deliberate
  limits. `own_pr_ci.OWN_PR_HEAD_PREFIXES` (`("aria/", "automation/")`) does not match
  `aria-impl-*`, so no `merge-outcomes` row would follow a merge until it does.
- Rings 5–6 as the docs define them are unreachable on any store today: `pr_merge` is
  `autonomous`-only (`runtime_profile.py:175`); the trial runs `strict`, whose runner calls
  `merge_if_green(dry_run=True)`; `autonomous` needs 30 `observe_success` events at L1
  (`docs/aria/policy/autonomy-unlock.json`) and `aria/state` carries no acceptance-events ledger;
  `aria-readiness-claim` has failed its last five runs.
- Side threats: PR #1550 (`automation/finding-closure-reconcile`, clean) rewrites the same
  registry rows the candidate rewrites — whichever lands second breaks the chain; ARIA-HIGH-117's
  deadline is 2026-09-16 (the 07:00Z sweep moves it to BLOCKED); HIGH-068 09-18, HIGH-097 / 106 /
  107 09-19. `aria/state` has published no cycle since 09-04; the last four nightlies were
  cancelled at the 360-min cap; the store has no `runtime-profile.json` (profile `standard` →
  the no-op implementation runner); `aria-state-maintenance` compacts daily.

## 3. What "closed" means and the decisions taken

"The chain is closed" is said only when ARIA has carried one of its own changes to merge with no
manual repair, and "ARIA works" only after external task zero
(`2026-09-14-aria-post-chain-plan.md:38-40`). Ring 3 is the kernel's `autonomy run` against the
converged store; rings 4–6 are the signed commit in the sandbox → the executor publishing → a real
PR → the merge authority → the outcome row.

| Ring                 | State                                                                 | Left                                                                                    |
| -------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| planning → CONVERGED | proven (trial eleven, 2026-09-12)                                     | —                                                                                       |
| 3 (cycle)            | four runs, none completed (the last two: slice thrash + adapter cost) | 140 (fix, no pins) · lab slice · nx `main` ref · adapter quarantine · ≥ 4 h deadline    |
| 4                    | 115 and 123 landed                                                    | 124 (round 6 half-verified) → 142 (kernel clients from the code root) → mint → executor |
| 5–6                  | no real-process proof                                                 | D1 below; `OWN_PR_HEAD_PREFIXES`; the Update-branch limit on record                     |
| PR-3 on main         | hosted lane red (23)                                                  | A / B / D / E on disk; 141                                                              |
| 137                  | open                                                                  | D2 below; Mode B (author = merger = operator) on record                                 |

Operator decisions, 2026-09-15:

- **D1** — Ring 6 on this run is the strict dry-run eligibility plus the operator's merge click,
  the one human act §137 permits when branch protection demands it. The autonomous ladder (30
  nights, the readiness lane, the branch prefix) is registered as its own finding: the merge
  authority has no live inputs.
- **D2** — Trial eleven's plan closes the chain and external task zero in one run; no new planning
  trial (no ARIA-own CONVERGED plan exists in any store; trials ten and eleven were the same task).
- **D3** — The runner stays disabled until PR #1553 is on `main`. With the runner off nothing
  queues: the hosted `runner-preflight` job fails by name and the self-hosted job is skipped, no
  catch-up; and the nightly checks out `main`, which carries neither 140 nor 124.
- **K1** — The implementation request for the CONVERGED plan is minted by a trial-harness driver
  that calls the kernel's own `AutonomousV9ImplementationRunner().run(...)` with an operator
  approval reference; the kernel writes the ledger rows. Recorded under §137 as an operator gesture,
  not a hand on the store.
- **K2** — The remote IDE session that shared the interactive slice is closed for the campaign.
- **K3** — PR #1550 merges first; the candidate is re-chained (`finding-registry.ts rechain-from`)
  and re-pinned; HIGH-117's deadline is extended in the same registry commit.
- No pre-push bypass (`CLAUDE.md:152`); the heavy pushes are scheduled, not skipped.

## 4. Host and session discipline (every block)

- **H1 — heavy work runs in `aria-lab.slice`**, the runner's documented budget reused while the
  runner is off: `systemctl set-property --runtime aria-lab.slice MemoryMax=8G MemoryHigh=6G
CPUWeight=50`, and per slot

  ```text
  systemd-run --unit=aria-lab-<slot> --slice=aria-lab.slice --collect \
    -p CPUQuota=200% -p OOMPolicy=continue -p KillMode=mixed -p TimeoutStopSec=900 \
    -p IOAccounting=yes -p IOReadBandwidthMax="/dev/sda 60M" -p IOWriteBandwidthMax="/dev/sda 30M" \
    -p StandardOutput=append:/root/aria-lab/<slot>.log -p StandardError=inherit \
    --working-directory=<worktree> -E HOME=/root \
    -E PATH=/root/.local/bin:/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin \
    -E TMPDIR=/dev/shm -E PYTHONDONTWRITEBYTECODE=1 <command>
  ```

  The memory limit lives on the slice, not the unit (a 3 GB unit limit would OOM-kill a cycle whose
  publish step measured 5.8 GiB). `HOME` and `PATH` are required: `gh auth git-credential` reads
  `/root/.config/gh/hosts.yml`, the pre-push hook needs `cargo`. Watching holds no child:
  `systemctl is-active`, `tail -n 20`, `systemctl show -p MemoryPeak`. A ring-3 stop is
  `systemctl kill --kill-whom=main -s SIGTERM aria-lab-ring3` (the script `exec`s `autonomy run`,
  so `_seal_cycle_on_escape` runs). `IOWeight` is inert on this host (mq-deadline); only the
  bandwidth caps act.

- **H2 — before any slot**: `sync; echo 2 > /proc/sys/vm/drop_caches`; `user-0.slice`
  `memory.current` under 1.5 GB and zero `memory.high` events over 60 s. No tree walks from the
  session (`find`/`du` under `/root/aria-planner-trials`, `git status --untracked-files=all` on the
  bare repository, `journalctl -b -1`). `apt-daily` and `apt-daily-upgrade` timers stopped for the
  campaign.
- **H3 — the watchdog runs outside the interactive slice and executes the abort itself**:
  `systemd-run --unit=aria-lab-watch --slice=aria-lab.slice -p MemoryMax=64M
/root/aria-lab/watch.sh` samples every 60 s into `/root/aria-lab/status.log`; thresholds: the
  slice's `memory.events high` delta over 100/min for 2 min, `/proc/pressure/io full avg60` over
  25 % (or the slice's `io.pressure` over 40 %), `sda` utilisation over 80 % with `await` over
  30 ms for 2 min, `dmesg` "blocked for more than"; load1 over 8 is secondary. On breach it sends
  SIGTERM to the slot's main process. The session reads `tail -n 3 status.log` every 10–15 min.
- **H4 — session protocol**: one fresh session per block; no `--resume` past ~150 turns — the plan
  file and the memory note are the resume mechanism; before every multi-hour unit the memory note
  gets block, unit name, log path, done-criterion, next step, and the session exits; every tool
  output is bounded (`tail`, `grep -c`, `wc -l`; never `cat` a log); pytest runs
  `-q -p no:cacheprovider --tb=short > log 2>&1`; no 60-second polling loops; a session stops at
  200 messages. The shell tool's 10-minute ceiling means anything longer is a unit.
- **H5 — reboot hygiene**: `git worktree prune` first (the prunable `/dev/shm/v6-*` entries block
  re-creation); the lane patch and every registry stub live under `/root/aria-lab/`; the last
  command of every ring unit bundles its evidence — the log, `tools/cycles.jsonl`,
  `tools/autonomy_state.jsonl`, `tools/agent-invocations/requests.jsonl`, `tools/governance*.jsonl`,
  `git rev-parse HEAD` and `git diff --stat` of the store — into
  `/root/aria-lab/evidence/<slot>-<ts>.tgz` with a checksum (the store is a worktree; its rows are
  uncommitted).
- **H6 — before every run**: the failure breaker (`breakers/autonomous-failures.jsonl`, 3 per
  72 h), `aria-kernel doctor`, a one-token provider probe (credit), and the leftover
  `/root/.aria/workspaces` directories cleared.

## 5. Order of work (fast first, one heavy thing at a time)

### Block −1 — this document (done in the session that wrote it)

Written, formatted, committed as a docs-only change and pushed; the pre-push selector runs no
suite for it. The dirty ARIA surface (§2.2) is stashed around the push so the authority hash check
compares the committed tree; the staged registry rows and review sections stay out of this commit
(K3 first).

### Block 0 — minutes, no suite (~1 h)

1. H2 / H5 / H6; the lab slice and watchdog; a ten-second rehearsal
   (`systemd-run --wait --pipe … gh auth status && cargo --version && claude --version`).
2. Registry hygiene (K3): #1550 lands, the candidate re-chains and re-pins; HIGH-117's deadline
   moves in the same commit (the sweep is at 07:00Z on 09-16).
3. `test_git_containment.py:404` (candidate) and `:407` (lane) get the same
   `assertRegex(r"No private key found|No such file or directory")`, byte-identical (the lane hunk
   carries :404 as context).
4. The four HIGH-140 pins: `test_cycle_runtime_status_degraded.py` (`integrity_valid=None` is
   `ok`/`degraded`, `phase_interrupted=True` is `failed` and never `integrity_failed`; the
   docstring names the semantic change — a filtered-out `artifact_integrity` used to be
   `integrity_failed`), `test_night_closes_at_deadline.py` (the closeout set is exactly
   `{artifact_integrity, metrics}`; with the deadline in the past a work phase records
   `skipped:job_deadline_reached`, a closeout phase `ran`, and `_run_phase_with_deadline` is never
   called for it; `_first_interrupted_phase`), `test_judgment_pipeline_phases.py`
   (`fixture_refresh` asks the clock between suites: one refreshed, the rest in
   `skipped_deadline`, one `fixture_refresh_deadline_skipped` row), `test_autonomy_orchestrator.py`
   (`phases` round-trips through the bounded summary; a non-dict becomes `{}`). Fails-before: the
   three kernel files stashed, the pins red, stash popped.
5. Review sections: §140 "what is now true / pins"; §124 (from the lane's `:1117-1145` plus the
   six rounds); §141's overstatement corrected.
6. `git -C /var/aqua-saas branch -f main origin/main`; the plan's three validation commands plus
   `format:check` measured once on the quiet host (a lab unit, ≤ 20 min) — the deadlines come from
   that measurement.
7. `run_post_converged_cycle.sh`: `ARIA_ZAI_API_KEY_FILE` and `ARIA_WORKSPACE_ROOT` kept; the
   wrong "adopts" sentence removed; provenance sidecar (`git stash create` SHA and the diff's
   sha256, since `exec > "$LOG"` truncates); `trial-r3.json` with `code_root` = the candidate and a
   `code_root_history` entry.

### Block 1 — scoped batches (lab units, ≤ 15 min each)

- Batch A (the 140 surface, candidate): `bash scripts/ci/aria-suite-run.sh` over
  `test_cycle_runtime_status_degraded.py test_phase_deadline.py test_job_deadline_scope.py
test_night_closes_at_deadline.py test_cycle_lifecycle_sealed_on_escape.py
test_judgment_pipeline_phases.py test_autonomy_orchestrator.py`.
- Batch B (the hosted-fix modules, with the `.py` suffix — the script maps by basename):
  `test_judge_digest_ssot.py test_self_improvement_remedy.py test_signing_agent.py
test_git_containment.py test_containment_probe.py test_sandbox_and_perimeter_hardening.py`.
  `tests/invariants/v12/…` paths go through pytest directly.

### Block 2 — commits and pushes #1 and #2

- Stash the three kernel files, the four pins, the registry and the review doc; commit **C1**
  `test(aria): the kernel suite runs on the hosted 22.04 lane too` (A / B / D / E, the :404 regex,
  `JUDGE-DIGEST.md`, `format-scope`). Push #1 as a lab unit (40 modules, ~45 min). Expected hosted
  result: 23 → 2 (group C only). Pop the stash after the push completes.
- Commit **C2** `fix(aria): a cycle cut by its deadline still seals its store` with
  `Closes: docs/reviews/claude/2026-09-12-aria-live-chain-blockers.md#ARIA-HIGH-140` — the three
  kernel files, the four pins, the 140 and 141 rows, §140 / §141, the debt-plan re-pin at 141,
  `invariants:fast`. One revertable commit. Push #2 (the `cycle` token selects ~305 modules, ~2 h)
  at least 90 min after hosted run #1 ends (`cancel-in-progress` on the head ref).

### Block 3 — the rest of round 6 (lane worktree, lab units, one module at a time, ~45 min)

`test_git_containment` → `test_containment_probe` → `test_managed_claude_sandbox` +
`test_claude_runtime_contract` → `test_signing_agent` → `v12_b_command_policy` and every module
mentioning `command_policy` → `test_autonomy_orchestrator` → `test_ci_executor_live_path_smoke` →
the nine workflow-reading modules. `test_pr_manager_e2e.py` runs in the candidate after the port
(editing the lane's node_modules literal would create the one real three-way conflict). Gates:
banned phrases (body included), markdownlint on the changed docs (two CONTRACTS lines at 101 / 103
columns), Prettier against the PR base, `aria:docs:ssot` (22/23 is the dirty-tree expectation),
the pedagogy lint, the jest prompt-contract spec. The drain-window fix (§2.1) with its
reproduction. Fails-before for the five round-6 fixes on a base worktree at the post-C2 candidate
tip; the real-bwrap e2e as `gharunner` on a shared clone under `/dev/shm` (`UnderRealBwrapTests`,
`test_containment_probe`, `test_executor_implementation_identity` only); both copies removed after.

### Block 4 — port, register, C3, push #3 (~full suite, ~3 h, overnight)

`git apply --3way --index /root/aria-lab/lane124-r6.patch` in the candidate (71 dirty paths with
the registry and review doc), `git worktree remove --force` the lane, `git worktree prune`,
`add-explicit ARIA-HIGH-124` (the lane's row minus the hashes, the six rounds in `notes`),
`verify`, re-pin, `invariants:fast`; commit **C3** `fix(aria): the agent produces evidence, the
executor publishes, gates and opens the PR` with the 124 trailer and the drain-window fix inside
it; push #3. Expected hosted: the two group-C reds, or green if 124 removed the noise.

### Block 5 — ARIA-HIGH-142 (new; the first real case of ARIA-HIGH-133), ~half a day

The in-sandbox kernel clients (hook client, MCP relay) load from the kernel's code root, not the
workspace; the code root is bound read-only into the sandbox when it lies outside the workspace;
the executor's repository root is given explicitly (`ARIA_WORKSPACE_ROOT`). Fix:
`kernel_root = Path(aria_kernel.__file__).parents[1]` in `claude_runtime.py`, `claude_settings.py`
and `mcp_client.py`; the root added to `implementation_safety._system_ro_binds`; pin: a workspace
fixture without `aria-kernel/` still gets working hooks and MCP. Registered, committed, pushed
(small selection).

### Block 5b — ARIA-HIGH-143: the implementer sandbox has no egress bound (1–2 h)

An external review of `origin/main` found the managed spawn without a PID namespace and without
`--die-with-parent`; **the candidate already has both** (`implementation_safety.py:1122`). What
remains is real: `MANAGED_SPAWN_ALLOW_NETWORK = True` (`:736`) with `/etc/resolv.conf` bound
means an agent can read `.env` (a read-only bind is visible) and send it anywhere; the only brake
is the model's judgment, which is what prompt injection targets. This sandbox has never run a real
implementation request; closing the gap before block 6 is cheap, after it is "after the first
exfiltration".

- Host: an allow-list egress proxy (`aria-egress-proxy`, a systemd unit in `system.slice`; a
  ~60-line Python CONNECT-only proxy preferred over tinyproxy for auditability) that admits only the
  provider endpoints — `api.anthropic.com`, the Z.ai transport endpoint from
  `tools/aria-poc/zai_runtime.py`, the Codex endpoints — on loopback; the sandbox receives it as
  `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`, which the kernel already passes through
  (`agent_env.py:41`, `BASELINE_ENV_NAMES`). Zero kernel lines for the proxy itself.
- Kernel: `--new-session --unshare-ipc --unshare-uts` on the managed spawn, mirrored by the probe;
  one pin under real bwrap — with `HTTPS_PROXY` pointed at a local fake proxy a `CONNECT` to a host
  off the allow-list is refused, and `/proc` shows only the sandbox's own PIDs.
- Rejected with the same review: a seccomp profile, gVisor / microVM, a separate worker VM (already
  ARIA-MEDIUM-139), hiding `.env` behind `/dev/null` (wrong layer).
- Registered with evidence `implementation_safety.py:736`, `agent_env.py:41`,
  `claude_runtime.py:677`; a CONTRACTS paragraph; committed and pushed. The nightly uses the same
  proxy on the same host (`aria-agent-executor.yml` env) before block 9.

### Block 6 — ring 4 live from the trial harness

1. Preconditions: blocks 5 and 5b landed; the proxy active; `nx run-many -t test -p
shell,notification-service` green once on the quiet host (`ci-affected` has had no push run on
   `main` since 08-23).
2. K1: `/root/aria-planner-trials/tools/request_implementation.py` calls
   `AutonomousV9ImplementationRunner().run(cycle_id=…, plan_id="flow-083f26574cade7dee7fc",
workspace_root=<task-source>, base_dir=<store tools>, profile="strict",
operator_approval_ref="trial:eleven:request-implementation")`. No cycle runs between this and
   the executor (the 24-hour reaper).
3. `/root/aria-planner-trials/tools/run_implementation_executor.sh`: the ring-3 environment plus
   `ARIA_WORKSPACE_ROOT=<task-source>`, `GH_TOKEN` from the runner `.env` (Mode B,
   `ARIA_REQUIRE_MODE_A` unset), `ARIA_JOB_LAUNCH_EPOCH` / `ARIA_JOB_DEADLINE_EPOCH` from the
   block-0 measurement (≥ 3 h), `ARIA_CLAUDE_SANDBOX=1`, `ARIA_ZAI_API_KEY_FILE`;
   `PYTHONPATH=<candidate>/aria-kernel python3 <candidate>/tools/aria-poc/ci_executor.py
<request_id>` as a lab unit with the evidence bundle.
4. Done: an `implementation_quarantine_published` row, an accepted result with a kernel-stamped
   `details.implementation.pr_url`, a real `[ARIA-AUTO]` PR on an `aria-impl-*` branch,
   `mode: pat_fallback` recorded, no hand on the store, the branch or a ledger.
5. `own_pr_ci.OWN_PR_HEAD_PREFIXES` gains `aria-impl-` (one line and a pin — a finding met on the
   way, closed at its class).

### Block 7 — rings 5–6 (D1)

The PR's required checks; "Update branch" if protection demands it (recorded); the operator's
merge click; the next cycle's `scan_merged_own_prs` / `pr_lifecycle merged` row; §137 closes with
the plan id, the PR number, the outcome, Mode B and the Update-branch limit. New findings: "the
merge authority has no live inputs" (the autonomous ladder, the readiness lane, the prefix);
`closes-footer-check` red on the product PR (`finding_id` is null; not required).

### Block 8 — ring 3, third run (heavy, overnight, ≥ 4 h)

Before: `doc-staleness-adapter` and the three adapters that exceed their budgets quarantined for
the trial with an approval reference (a third streak would open three HUMAN_REQUIRED records); the
nx `main` ref; the block-0 script; `DEADLINE` from the measurement (≥ 14,400 s); a lab unit at
8 GB. Done: the last `cycles.jsonl` row `status == completed` **and** the last
`autonomy_state.jsonl` row with `details.runtime_status` in `{ok, degraded}` and `details.phases`
present. If the deadline still bites: `failed` naming the interrupted phase plus a
`fixture_refresh_deadline_skipped` row — 140 behaved; the wall-clock is ARIA-HIGH-136's and
ARIA-MEDIUM-139's subject.

### Block 9 — afterwards

1. ARIA-HIGH-141 (the tmpfs common dir) → push → the hosted unittest half green for the first time
   → the pytest half runs hosted for the first time; the 110-minute budget is watched and raised
   with a run id if needed (`aria-kernel.yml:85` and `aria-doc-runtime-ssot.spec.ts:639`
   together).
2. PR #1553 merges (policy: kernel lane green). Then ARIA-HIGH-117 (the `aria/state` restore
   class), `profile set --profile strict` published to `aria/state`, a nightly deadline from the
   measurement — and only then the runner is re-enabled (D3).
3. ARIA-HIGH-097 (the adjudication envelope: `validate_adjudication_response`, `_load_opinion`
   through it, the executor passthrough of `verdict` / `disposition` / `rationale`, the pre-submit
   refusal, a round-trip test), then the post-chain order 136 → 127 → 138 ….

## 6. Verification

- Blocks 1–2: batches A and B `OK`; the pins red with the fix stashed; hosted run #1 at 23 → 2;
  C2 a single revertable commit.
- Blocks 3–4: every module green with `--durations` on record; registry `verify` clean;
  `invariants:fast` green; the commit-msg hook satisfied (trailer, registry id, `review_file`).
- Blocks 6–7: a real PR with a kernel-stamped `pr_url` and `mode: pat_fallback`; the four required
  checks green; `pr-lifecycle merged` after the click; the evidence bundle under
  `/root/aria-lab/evidence/`.
- Block 8: the criteria above; the evidence bundle.
- Traps: gitleaks (test literals stay split), the merge-authority literal scan, markdownlint's
  100-column limit on prose, Prettier against the PR base, no partial staging of the ARIA surface,
  pushes at least 90 min apart, the HIGH-117 sweep, the PR #1550 collision.
