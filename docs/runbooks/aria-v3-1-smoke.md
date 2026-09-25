<!-- ARIA-CURRENT-STATE-NOTICE: Historical/compatibility runbook. For live ARIA runtime authority, see docs/aria/CURRENT_STATE.md and executable contracts. Snowball/Claude-era instructions below are not current runtime authority unless reaffirmed there. -->

# Runbook — ARIA V3.1 Smoke + V10.3-B Endurance Gate

**Owner:** Operator (Okan)
**Phase:** Plan ARIA-V3.1 — operator-side smoke + V10.3-B 20-cycle autonomous endurance
**Status:** OPEN — V3.1 code arc + follow-ups (B2/B3/C2/D2) landed on `snowball`; this runbook is the operator-executed gate before V10.3-B is allowed to fire.

## Why this runbook exists

The V3.1 wire-up arc (commits dc3c7fec → b338ff97 on `snowball`) made 5 vision pillars LIVE:

* V9.4 5-source pressure mining (operator_feedback > failing_ci > orphan_finding > f_finding > git_diff) replaces V7 git-diff-only.
* V9 implementation phase fires CONVERGED → signed-commit PR via `AutonomousV9ImplementationRunner`.
* V10 memory pillar records `convention` rows per CONVERGED cycle via `MemoryHookImpl` (bounded reader → stability gate → record → verify chain → HUMAN_REQUIRED skill genesis).
* V10.4 per-cycle cost attribution via `CostTelemetryHookImpl` (signed rows + drift detection).
* V9.0-C cert-bound signing infrastructure auto-configures `git commit -S` via `mint_signing_key`.

Code is fully landed + invariant-tested (2184/2184 GREEN). Two operator gates remain:

1. **V3.1-F smoke** — 5-cycle strict-profile run on a fresh-clone sandbox with `ARIA_DRY_RUN=true` proving the wire-up produces the expected governance event volume + no V8 invariant regressions.
2. **V10.3-B endurance** — 20-cycle autonomous-profile run with GitHub App Mode A scoped installation tokens proving the full autonomous loop holds cost + safety budgets across a sustained burn.

This runbook chains both: F-1 → F-4 → F-5 acceptance → V10.3-B prerequisites → 20-cycle endurance → V10.3-B acceptance.

## Prerequisites checklist

Before running ANY procedure below:

```bash
# 1. Confirm snowball is at the V3.1-D2 commit or newer.
git -C /var/aqua-saas fetch origin snowball
git -C /var/aqua-saas log --oneline origin/snowball | head -1
# Expected SHA must be b338ff97 (V3.1-D2) or descendant.

# 2. Confirm full kernel suite green at HEAD.
cd /var/aqua-saas
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:. \
  python3 -m unittest discover -s aria-kernel -p '*test*.py' -t aria-kernel 2>&1 | tail -3
# Expected: "Ran 2184 tests in ... OK (skipped=28)"

# 3. Confirm aria-implementer agent file exists + readable. V9.0-D's
#    IMMUTABLE_AGENT_FILE_HASH_REGISTRY enforces drift detection at
#    invocation time; this prereq just verifies the file is present.
test -r /var/aqua-saas/.claude/agents/aria-implementer.md && echo "OK: aria-implementer agent file present"
# Expected: "OK: aria-implementer agent file present"
```

If ANY of the 3 checks fails, STOP. Do not run smoke or endurance — first root-cause the failure.

## Stage 1: V3.1-F Smoke (5-cycle strict, dry-run)

### F-1: Fresh-clone sandbox setup

Smoke runs against a fresh clone — your `/var/aqua-saas` worktree is NOT mutated.

```bash
SMOKE_DIR=/tmp/aria-smoke-$(date +%Y%m%d-%H%M%S)
mkdir -p "$SMOKE_DIR"
cp -r /var/aqua-saas/. "$SMOKE_DIR/"
cd "$SMOKE_DIR"
echo "SMOKE_DIR=$SMOKE_DIR"
# Keep this path — F-5 acceptance criteria reads governance + cost
# rows from $SMOKE_DIR/aria-tools/.
```

### F-4: 5-cycle strict-profile smoke command

```bash
cd "$SMOKE_DIR"
# Persisted profile MUST be set BEFORE the autonomy run so CLI
# override audit row lands cleanly.
PYTHONPATH=aria-kernel:. python3 -m aria_kernel profile set \
  --profile strict --operator-approval-ref "v31-f-smoke"

# 5-cycle smoke. ARIA_DRY_RUN=true short-circuits scan_failing_ci
# + mint_installation_token (V3.1-F-2 gate); CLAUDE_CODE_MOCK=true
# routes the LLM calls through ci_executor's mock path. The
# `unshare --net` namespace isolation is the operator-side Tier-1
# defense in depth.
ARIA_DRY_RUN=true CLAUDE_CODE_MOCK=true \
  unshare --net -- \
  env PYTHONPATH=aria-kernel:. python3 -m aria_kernel autonomy run \
    --workspace-root "$SMOKE_DIR" \
    --tools-dir "$SMOKE_DIR/aria-tools" \
    --max-cycles 5 \
    --profile strict \
    --operator-approval-ref "v31-f-smoke" \
    --cycle-deadline-seconds 1800 \
    --max-rounds 2 \
    --max-budget-usd-per-run 10.00 \
    --max-budget-usd-per-cycle 1.50 \
  2>&1 | tee "$SMOKE_DIR/v31-f-smoke.log"
```

Expected wall-clock: 5–15 min depending on host. Watchdog kills any cycle > 1800s.

### F-5: Acceptance criteria

Check each signal below. ALL must hold for smoke to pass.

```bash
cd "$SMOKE_DIR"
GOV="$SMOKE_DIR/aria-tools/governance.jsonl"
COST="$SMOKE_DIR/aria-tools/cost-attribution/$(date +%Y-%m).jsonl"
KG="$SMOKE_DIR/aria-tools/knowledge-graph/conventions.jsonl"

# 1. autonomy_orchestrator_started + autonomy_orchestrator_exit cleanly.
grep -c '"kind":"autonomy_orchestrator_started"' "$GOV"
grep -c '"kind":"autonomy_orchestrator_exit"' "$GOV"
# Expected: 1 + 1

# 2. Plan source mining selected per cycle.
grep -c '"kind":"plan_candidate_source_selected"' "$GOV"
# Expected: == 5 (one per cycle) OR cycle_runner_no_pressure events
# == 5 if the smoke workspace has no V9.4 pressure (depends on
# orphan-findings.md state, failing CI cache, operator-feedback rows).

# 3. Memory hook fired per CONVERGED cycle (if any cycle converged).
grep -c '"kind":"convention_recorded"\|"kind":"memory_hook_recorded"' "$GOV"
# Expected: >= 1 IF any cycle reached CONVERGED. Under DRY_RUN the
# LLMs are mocked; convergence depends on the mocked agent
# verdicts. Both 0 and >=1 are acceptable — the key signal is
# memory_hook_failed events MUST be 0.
grep -c '"kind":"memory_hook_failed"' "$GOV"
# Expected: 0

# 4. Cost attribution row format pinned.
if [[ -f "$COST" ]]; then
    python3 -c "
import json
with open('$COST') as f:
    for line in f:
        if not line.strip(): continue
        row = json.loads(line)
        assert row['signer_key_fp'].startswith('SHA256:'), row
        assert row['agent_role'] in ('primary_plan','challenger_plan','cross_review','implementation','specialist_review')
        assert isinstance(row['input_tokens'], int) and row['input_tokens'] >= 0
print('cost-attribution rows OK')
"
fi
# Expected: "cost-attribution rows OK" OR no file (V3.1-D3 follow-up
# wires the per-LLM-call record; D2 only wired the hook + factory).

# 5. Orphan reaper fired exactly once (zero false positives on a
#    fresh sandbox — there are no IMPLEMENTATION_REQUESTED orphans).
grep -c '"kind":"implementation_orphans_reaped_summary"' "$GOV"
# Expected: 0 (fresh sandbox has no orphans) OR 1 (summary fires
# even with reaped_count=0 in the future; current code suppresses
# on zero).

# 6. CLI profile override audit row landed.
grep -c '"kind":"runtime_profile_changed"' "$GOV"
# Expected: 1 (the `profile set` command + the autonomy-cli override
# both leave audit rows; the `profile set` is the first, the
# autonomy-cli is a no-op because args.profile == _persisted_profile).

# 7. ARIA_DRY_RUN gate observable.
grep -c '"kind":"commit_signature_verify_skipped_dry_run"' "$GOV"
# Expected: 0 (dry-run never reaches the implementation dispatch
# path because no plan converges under mock LLM verdicts in 5 cycles).
# This is the "no false positive" check, not a "must fire" check.

# 8. Aria-debts/keys/ cleanup.
ls "$SMOKE_DIR/aria-debts/keys/" 2>/dev/null | wc -l
# Expected: 0 (try/finally cleanup + 24h startup prune are the
# anchors; a fresh sandbox has no stale keys).

# 9. V8 invariant regression check.
PYTHONPATH=aria-kernel:. python3 -m unittest discover \
  -s aria-kernel/tests/invariants/v8 -t aria-kernel 2>&1 | tail -3
# Expected: "Ran X tests ... OK"

# 10. F-3 autonomous-preflight refusal test (1-cycle, no GH_TOKEN).
GH_TOKEN="" PYTHONPATH=aria-kernel:. python3 -m aria_kernel autonomy run \
    --profile autonomous \
    --operator-approval-ref "v31-f-preflight-smoke" \
    --tools-dir "$SMOKE_DIR/aria-tools-preflight" \
    --workspace-root "$SMOKE_DIR" \
    --max-cycles 1 \
  2>&1 | tail -10
# Expected: GovernanceError "autonomous_profile_preconditions_not_met"
# stack trace AND rc != 0. NO cycle should start.
```

If ALL 10 checks pass → V3.1-F smoke ACCEPTED. Append a row to `aria-findings/F-015.json#F-015-V31-F` `executed_at` field + commit the metadata update.

If any check fails → STOP. Root-cause before proceeding to endurance.

## Stage 2: V10.3-B Endurance Gate Prerequisites

The endurance gate runs the autonomous profile against the real GitHub API + live `claude` CLI for 20 cycles. Tier-1 requirements:

### Prerequisite A: GitHub App Mode A (REQUIRED)

V10.3-B MUST run with scoped installation tokens — operator-PAT fallback (Mode B) is V10.3-A-acceptable but V10.3-B-FORBIDDEN. Run the setup once:

```bash
# Follow docs/runbooks/aria-github-app-setup.md sections 1-4
# verbatim. At the end you should have:
ls ~/.config/aria/gh-app-private-key.pem  # 600 perms
echo "$ARIA_GH_APP_ID"  # numeric
echo "$ARIA_GH_APP_INSTALLATION_ID"  # numeric
echo "$ARIA_GH_APP_PRIVATE_KEY_PATH"  # absolute path
```

Validate Mode A actually mints a real token (NOT the fallback shim):

```bash
PYTHONPATH=aria-kernel:. python3 -c "
import os
os.environ['ARIA_GH_APP_INSTALLATION_ID'] = os.environ['ARIA_GH_APP_INSTALLATION_ID']
from aria_kernel.gh_token_factory import mint_installation_token
lease = mint_installation_token(cycle_id='v10-3-b-precheck', workspace_root='/tmp')
assert not lease.fallback_active, 'FATAL: Mode B fallback fired; Mode A not configured'
print('Mode A token mint OK; installation_id=', lease.gh_app_installation_id)
"
```

### Prerequisite B: Branch protection capture

V9.0-C preflight reads `gh api repos/owner/repo/branches/snowball/protection` + persists the response to `aria-tools/preflight/snowball-branch-protection-v3.json`. Already in repo as of beeea74a^; verify it's still current:

```bash
ls -la /var/aqua-saas/aria-tools/preflight/snowball-branch-protection-v3.json
# Expected: file exists, valid JSON
PYTHONPATH=aria-kernel:. python3 -m unittest \
  aria-kernel.tests.invariants.v3.test_phase_a0_preflight 2>&1 | tail -3
# Expected: OK
```

### Prerequisite C: Budget envelope

Endurance budget cap is operator-set. Plan v3 target: $45 per run, $1.50 per cycle (20 cycles × $1.50 = $30 + 50% headroom).

```bash
echo $MAX_BUDGET_USD_PER_RUN
echo $MAX_BUDGET_USD_PER_CYCLE
# If unset, the CLI flag defaults take over; document the values
# you'll pass.
```

### Prerequisite D: Operator approval ref

Endurance is operator-explicit. Generate a signed approval ref:

```bash
APPROVAL_REF="v10-3-b-endurance-$(date +%Y%m%d-%H%M%S)"
echo "APPROVAL_REF=$APPROVAL_REF"
# Document this in your operator runbook log + the F-015 update.
```

### Prerequisite E: V3.1-F smoke passed

Stage 1 above MUST be ACCEPTED before endurance fires. The smoke proves the wire-up does not regress V8; endurance proves the wire-up holds under sustained load.

## Stage 3: V10.3-B 20-cycle autonomous endurance

### Pre-launch checklist

```bash
# 1. Working tree clean on snowball.
cd /var/aqua-saas && git status -s | head -5
# Expected: empty or only aria-tools/ runtime state (deletions OK).

# 2. snowball at V3.1-D2 or descendant.
git log --oneline origin/snowball | head -1
# Expected: descendant of b338ff97.

# 3. ARIA_STOP file absent.
ls /var/aqua-saas/aria-tools/ARIA_STOP 2>&1 | grep -q "No such" && echo "OK: no ARIA_STOP"

# 4. Aria-debts/keys/ empty.
ls /var/aqua-saas/aria-debts/keys/ 2>/dev/null | wc -l
# Expected: 0

# 5. Capture starting state size for delta analysis.
wc -l /var/aqua-saas/aria-tools/governance.jsonl 2>/dev/null
wc -l /var/aqua-saas/aria-tools/plans/events.jsonl 2>/dev/null
```

### Launch command

```bash
cd /var/aqua-saas
APPROVAL_REF="v10-3-b-endurance-$(date +%Y%m%d-%H%M%S)"

# Profile transition: standard -> autonomous via set_profile audit row.
PYTHONPATH=aria-kernel:. python3 -m aria_kernel profile set \
  --profile autonomous --operator-approval-ref "$APPROVAL_REF"

# Endurance run. NOTE: NO ARIA_DRY_RUN — this fires real LLM + gh
# subprocess calls. The GH App scoped installation token (5-min TTL)
# is the trust anchor.
GH_TOKEN="${GH_TOKEN:?GH_TOKEN required for Mode A preflight}" \
PYTHONPATH=aria-kernel:. python3 -m aria_kernel autonomy run \
    --workspace-root . \
    --tools-dir ./aria-tools \
    --max-cycles 20 \
    --profile autonomous \
    --operator-approval-ref "$APPROVAL_REF" \
    --cycle-deadline-seconds 1800 \
    --max-rounds 3 \
    --max-budget-usd-per-run 45.00 \
    --max-budget-usd-per-cycle 1.50 \
  2>&1 | tee "/tmp/v10-3-b-endurance-$(date +%Y%m%d-%H%M%S).log"
```

Expected wall-clock: 4–10 hours depending on convergence + impl phase wall-clock per cycle.

### Mid-run monitoring

```bash
# In a separate terminal, tail key signals:
tail -F /var/aqua-saas/aria-tools/governance.jsonl | \
  grep --line-buffered -E '"kind":"(autonomy_orchestrator_(started|exit)|cycle_(started|completed|deadline_exceeded)|convergence_(resolved|blocked)|implementation_(requested|started|outcome_recorded|merged|rejected)|memory_hook_(recorded|failed)|cost_attribution_record_failed|autonomy_orchestrator_refused)"'

# Cost budget check every 30 min:
PYTHONPATH=aria-kernel:. python3 -c "
from aria_kernel.budget import read_cost_attribution
rows = read_cost_attribution(base_dir='/var/aqua-saas/aria-tools')
total = sum(r.get('estimated_usd', 0) for r in rows)
print(f'spent={total:.2f} USD across {len(rows)} rows')
"
```

If at any point the spent estimate exceeds $40 OR you observe `autonomy_orchestrator_refused` events in rapid succession:

```bash
# Emergency halt — operator-side ARIA_STOP.
echo "operator_halt_$(date +%s)" > /var/aqua-saas/aria-tools/ARIA_STOP
# The orchestrator checks ARIA_STOP at the top of every cycle +
# exits cleanly with exit_reason="aria_stop". DO NOT kill the
# Python process directly — that would orphan IMPLEMENTATION_IN_FLIGHT
# state.
```

### V10.3-B Acceptance criteria

After the run completes (or is operator-halted), verify ALL of:

| Signal | Source | Expected |
|---|---|---|
| Exit reason | last `autonomy_orchestrator_exit` event | `max_cycles` or `aria_stop` |
| Cycles completed | exit event details | ≥ 15 (75% completion floor) |
| Total spend | sum of cost-attribution `estimated_usd` | ≤ $45 |
| Cost-row coverage | rows per cycle | ≥ 2 (every cycle has at least primary + challenger LLM rows) |
| All cost rows signed | every row | `signer_key_fp` starts `SHA256:` |
| Memory pillar live | governance | ≥ 1 `convention_recorded` event |
| Knowledge graph chain | `verify_chain_or_quarantine` | returns (True, count) |
| Skill genesis HUMAN_REQUIRED | governance | 0 OR ≥ 1 (stable=True is rare in 20 cycles; both are acceptable but 0 occurrences of `aria-tools/registry.json` direct write) |
| Aria-debts/keys/ post-run | filesystem | 0 (try/finally + startup prune) |
| 0 V8 invariant regressions | invariant suite | full V8 suite GREEN post-run |
| 0 ungated profile transitions | governance | every `runtime_profile_changed` has `operator_approval_ref` non-empty |
| 0 unsigned commits in merged PRs | git log on `snowball` | every `aria-impl-*` commit `git verify-commit` passes |

If ALL acceptance signals hold → V10.3-B PASSED. Update `aria-findings/F-015.json#F-015-V10-3-B` status to RESOLVED + commit the metadata + the operator runbook log path.

If ANY signal fails → V10.3-B FAILED. Open a CRITICAL/HIGH finding under F-015 with the failing signal + root cause analysis. Do not retry the endurance until the root cause is architecturally fixed (CLAUDE.md "no patches, no deferrals" rule).

## Failure recovery procedures

### Recovery R-1: Mid-run autonomy_orchestrator_refused storm

Symptom: governance.jsonl shows `autonomy_orchestrator_refused` events in rapid succession.

```bash
# Stop the run via ARIA_STOP.
echo "refusal_storm_$(date +%s)" > /var/aqua-saas/aria-tools/ARIA_STOP
# Wait for the current cycle to exit cleanly (check governance for
# `autonomy_orchestrator_exit`).
# Diagnose by reading the LAST 5 refusal events:
grep '"kind":"autonomy_orchestrator_refused"' \
  /var/aqua-saas/aria-tools/governance.jsonl | tail -5
# Common causes:
#   - cost_breaker_tripped — operator-side cost-cap reached
#   - autonomous_host_lease_blocked — concurrent autonomous run elsewhere
#   - autonomous_profile_preconditions_not_met — GH App degraded
# Fix the root cause architecturally; re-run from scratch (do NOT
# resume mid-run — the V31-B3 orphan reaper handles partial state
# at next startup).
```

### Recovery R-2: Cost cap exhaustion

Symptom: `cycle_budget_exhausted` rejection_class on multiple plans.

The plan v3.1-E budget caps (`--max-budget-usd-per-run`, `--max-budget-usd-per-cycle`) are hard kill-switches. If the cycle exhausts the per-cycle cap, the implementer phase rejects with `cycle_budget_exhausted`. This is NOT a failure — it's the safety contract firing.

If the rate of cycle_budget_exhausted exceeds 30% of cycles, the per-cycle budget is too low for the workload. Operator action: increase `--max-budget-usd-per-cycle` to 2.50 (and `--max-budget-usd-per-run` to 60 for budget room) AND re-launch.

### Recovery R-3: Signed commit verification failure

Symptom: governance shows `commit_signature_unverified` rejections — since ARIA-HIGH-124
round 4 as `implementation_delivery_refused` with `stage=commit_identity` and
`reason=commit_unverified:commit_signature_unverified…` (the executor's delivery verifies the
published tip against the key it holds BEFORE it pushes; nothing was pushed, no PR exists, the
request is HUMAN_REQUIRED), or on the bridge's replay path as an `agent_bridge_warning`.

The verifier (`plan_convergence_bridge.verify_implementation_commit`, the one both sites run)
checks `branch_tip_sha` against the public key registered in `kg_signers` for the fingerprint
the executor holds for the request (ARIA-HIGH-115); the message names which step refused — no
fingerprint, a fingerprint the registry does not hold, one registered under another cycle, or a
commit that does not verify against the registered key in the named checkout. The command
policy refuses every `git commit` option that could select another key or author by name
(`commit_identity:git_commit_foreign_option`), so a refusal here means the agent made the commit
outside the Bash tool (a unittest module, a script) — read the transcript. STOP the run. Verify:

```bash
# The executor's identity is minted in the REQUEST WORKTREE while the agent runs
# (<checkout>/aria-worktrees/req-<id>/aria-debts/keys/<cycle_id>), registered in
# knowledge-graph/signers.jsonl (surface kg_signers) before the agent starts, and
# RETIRED right after the quarantine's publication — before the executor's gate,
# push and PR (`implementation_identity_retired`, ARIA-HIGH-124 round 5) — so look
# at the ledgers, not the (removed) worktree:
grep '"cycle_id"' <tools-dir>/knowledge-graph/signers.jsonl
grep 'implementation_signing_unavailable\|implementation_signer_fp_overridden\|implementation_identity_retired' <tools-dir>/governance.jsonl
# While a request worktree still exists, its config is `--worktree` scoped:
git -C <worktree> config --worktree --get commit.gpgsign   # Expected: "true"
git -C <worktree> config --worktree --get gpg.ssh.allowedSignersFile
# Expected: <git rev-parse --absolute-git-dir>/aria-allowed-signers
```

An `implementation_signing_unavailable` release (harness-class; the request stays queued) names why
the identity could not be held in that tree: `shared_checkout_scope:--local` means the child ran
in the shared checkout — turn `executor.worktree_per_request` on; `identity_already_held` means
another holder owns this cycle's key in that tree; `signing_agent_unavailable:<reason>` means the
kernel could not hold the ssh-agent that signs for the sandbox (`ssh_agent_missing`,
`socket_path_too_long` — the host's temp root is too long for a unix socket);
`git_containment_refused:<reason>` means the worktree cannot host a commit-capable sandbox
(`hooks_dir_unresolvable:<why>` — git did not name the effective hooks directory).

### Recovery R-3b: The sandbox cannot host a commit (ARIA-HIGH-123)

Symptom: the pre-claim gate refuses `sandbox_unavailable` with `git containment probe refused:
<reason>` in the governance row's `detail`, and the request stays PENDING with no claim.

The containment probe (`aria_kernel.containment_probe`) mints a throwaway key into a throwaway
linked worktree, holds the kernel-side ssh-agent, derives a commit-capable sandbox, stands it on
the probe's `aria-impl-*` branch the way the executor stands the implementer's (ARIA-HIGH-124), and
runs `git status`, the branch check and a SIGNED `git commit` inside the real bwrap argv (the
managed route's network setting), then publishes the worktree's quarantine the way the executor
does and verifies the commit from outside. The reason names what failed:

```bash
# Reproduce the probe by hand (no request, no claim, no key of yours):
PYTHONPATH=aria-kernel python3 -c "
from aria_kernel.implementation_safety import _git_containment_probe_reason
print(_git_containment_probe_reason())"   # Expected: None
# `git_in_sandbox_failed:rc=128:error: No user exists for uid N?` — the account database is not
#   bound (`/etc/passwd`, `/etc/group` are system binds; ssh-keygen resolves its uid before it
#   signs). Runs as the runner's uid what a root shell hides (nss-systemd synthesizes root).
# `git_in_sandbox_failed:rc=128:...Read-only file system` — a bind the sandbox needs is missing
#   (the replica over the worktree's git dir, the quarantine's refs dirs at the common paths);
#   read the wrapper's argv.
# `sandbox_commit_did_not_reach_repository` / `sandbox_publication_refused:<why>` — the branch
#   never reached the quarantine the kernel publishes from, or the publication refused it.
# `sandbox_lock_reached_repository` — a ref lock planted inside landed on the host: the shared
#   `refs/heads` is bound writable somewhere.
# `git_in_sandbox_failed:rc=41` / `rc=42` / `rc=43` — the common config, the hooks dir or the
#   PRIVATE KEY is reachable inside: the read-only overlays / the keys-dir mask are not the last
#   mounts.
# `git_in_sandbox_failed:rc=44` — the sandbox did not start on the branch the kernel stood it on
#   (the replica's HEAD is shadowed inside); `probe_branch_refused:<why>` — the kernel could not
#   stand it there at all (`git_containment.stand_on_implementation_branch`'s reasons).
# `probe_containment_refused:loose_refs_exceed_overlay_bound:<n>` — the checkout carries more
#   loose branches than the sandbox overlays one by one; run `git pack-refs --all` in it.
```

Inside a request worktree's sandbox the implementer starts ON its `aria-impl-*` branch at the
staged base (the executor stood it there before the spawn — ARIA-HIGH-124) and can `git add` and
`git commit` (signed through the kernel-held ssh-agent — the private key is not mounted). Its git
writes go to the worktree's QUARANTINE (`<private git dir>/aria-sandbox/`: objects, refs,
reflogs), never to the shared repository; the executor publishes the quarantine after the spawn
(`implementation_quarantine_published` on governance: objects migrated, packs unpacked, the
`aria-impl-*` ref published, everything else discarded by name), then DELIVERS it itself (R-3c).
`git push` and every `python3 -m aria_kernel …` are refused inside by name (`kernel_authority` in
the hook's verdict) and `gh pr create` is admitted nowhere: that is the policy working, not a
fault. The executor's OWN kernel commands after the spawn run with `-P` (`kernel_cli.py`): a
kernel package or a `json.py` the agent wrote at its worktree root never resolves as the
executor's kernel. `.git/hooks` (the
EFFECTIVE hooks dir — `.husky` when `core.hooksPath` says so), `config`, `config.worktree`,
`aria-allowed-signers`, existing loose refs, the shared packs, `objects/info/alternates`, sibling
worktrees and the main checkout's working tree are read-only or absent. A write there fails with
`Read-only file system`; that is the sandbox working, not a fault. The state store is not mounted
at all: the hooks reach the kernel through the broker's socket (`/tmp/aria-hook-broker.sock`); a
hook that prints `hook_broker_unreachable:<why>` means the executor's broker is not being served
around the spawn — read the executor's stderr for the spawn that ran. The `aria` MCP view is
served the same way (`/tmp/aria-mcp-broker.sock`, relayed in by `mcp_relay.py`); a tool that
answers `mcp_broker_unreachable:<why>` means the same thing for the MCP broker.

### Recovery R-3c: The executor's delivery refused (ARIA-HIGH-124)

Symptom: governance shows `implementation_delivery_refused` (`stage`, `reason`), the request is in
HUMAN_REQUIRED (`aria-tools/human-required/<request_id>.json` names the stage; the claim event
of the same release is `human_required`, so `agent next-pending` never hands it out again) and
the claim was released under `implementation_delivery_refused:<stage>`; or, before any turn,
`implementation_branch_collision` with `git_containment_refused:implementation_branch_exists`,
or `implementation_request_invalid` with
`git_containment_refused:implementation_branch_name_invalid` / `base_sha_not_an_object_id` (the
request row's `implementation_ids` cannot stand a sandbox — re-stage the plan).

The executor delivers the published branch after the spawn — apply gate at the branch tip in
the request worktree, push with the credential it holds, PR through `open_pr_for_action` — and
stamps the result (`implementation_delivered`). Each stage refuses by name:

```bash
grep 'implementation_delivered\|implementation_delivery_refused\|implementation_branch_collision' \
  <tools-dir>/governance.jsonl | tail -5
# stage=branch_publication reason=branch_not_published:…=branch_unadvanced — the agent committed
#   nothing on the branch: the kernel's seed was discarded, no branch exists in the checkout.
#   The plan's key_changes were not applied; read the transcript, then requeue.
# stage=branch_publication reason=branch_not_published:… (other discards) — the agent's commit
#   was on a branch of its own naming (discarded by the publication) or an object was refused.
# stage=commit_identity reason=commit_unverified:commit_signature_unverified… (round 4) — the
#   published tip does not verify against the key the executor held for this request: unsigned,
#   signed with a key of the agent's own, or with another cycle's. Decided BEFORE the admission,
#   the gate, the push and the PR — nothing left the runner. See Recovery R-3.
# stage=apply_gate reason=gate_blocked:<blocked_by> — the canonical suite regressed at the tip or
#   the diff carries a suppression pattern; the action is `blocked` on apply/actions.jsonl.
# stage=apply_gate reason=gate_refused:… — the gate could not run (dirty worktree, unresolved
#   change id); read the reason, it is the kernel's own GovernanceError. `validation requires a
#   clean git worktree` means the agent left an untracked, non-ignored file in the request
#   worktree (scratch output, a build artefact not in .gitignore): the commit is good but the
#   gate refuses a tree that is not the commit — fail-closed by design; the plan's intended
#   surfaces or the repository's .gitignore is where such a path belongs.
# stage=change_ledger reason=change_committed_refused:scope_drift_requires_human:… — the tip
#   touches a file the plan did not intend. Decided BEFORE the tip's suite runs (round 3): the
#   action stays `staged_for_implementation`, no candidate validation group exists.
# stage=admission — NOT escalated: released harness-class (`implementation_delivery_unavailable`,
#   the request stays queued). `deadline_insufficient:remaining=…:worst_case=…` — the job's
#   remaining window (ARIA_JOB_DEADLINE_EPOCH) could not hold the delivery's worst case; decided
#   before the spawn (no turn spent) and again before the quarantine is published
#   (`implementation_quarantine_discarded`: the agent's commit is discarded, no branch exists,
#   the retry stands on it again). `sandbox_unavailable:…` — the validation sandbox could not be
#   built for a staged command (bwrap unusable, an executable not on the validation
#   environment's PATH, a bind that would reach the store); read the executor's stderr.
# The gate's suite runs CONTAINED (round 3): every recorded run's log names the bwrap argv.
#   A suite that needs the network, the runner's home caches or a toolchain outside
#   `/usr`/`/usr/local` and the resolved PATH entry's prefix fails inside — that is the sandbox
#   working, not a fault; the recipe belongs in the registered experiment recipes with what it
#   needs declared. A command that hits its ceiling is recorded `timed_out` and its whole tree
#   is gone with it (round 4: `--unshare-pid --die-with-parent` on the wrapper, the process
#   group killed by the runner) — a `sleep`/`jest` survivor on the runner after such a refusal
#   is a defect, not a leftover to clean.
# stage=push reason=push_failed:rc=<n>:<git's first line> — the remote refused (credential,
#   network, a non-fast-forward against an earlier attempt's push); the intent/receipt rows are
#   on recovery/external-effects.jsonl.
# stage=pr_open reason=pr_open_refused:… — GATE_PRE_PR_OPEN or the opener refused (commit
#   contract, secret scan, `gh` itself).
# A published branch (the agent DID commit) survives in the checkout:
#   `git -C <checkout> branch --list 'aria-impl-*'`. A retry of the SAME request is refused
#   before any turn (`implementation_branch_collision`) while that branch exists — deliver it by
#   hand or delete it, then requeue. A spawn that ended before any commit (a timeout, a provider
#   outage, a cancel) leaves NO branch: its harness-class retry stands on the branch again.
```

`implementation_delivery_unavailable` (harness-class, the request stays queued) means the
executor could not mint the delivery credential before the spawn — no GH App installation and no
operator PAT (`docs/runbooks/aria-github-app-setup.md`) — or, since round 3, that the delivery's
admission refused (the governance row of that name carries `reason`: `deadline_insufficient` /
`sandbox_unavailable`, and `decided`: `before_spawn` / `before_publication`).

`human_required_record_unavailable:<escalation reason>` (harness-class, a job error
`::error::aria executor could not record HUMAN_REQUIRED …`, governance row of the same name)
means the executor escalated the request but the kernel's recorder did not land the record (a
refused store write, a dying disk): the request stays queued with its budget intact and the retry
escalates again once the recorder answers; fix the store, then requeue.

`executor_drain_window_skip` (governance, `worst_case_seconds`, `remaining_seconds`) means the
drain selected a request whose own worst case — an implementation's staged suite at its ceiling,
recipes included — no longer fit tonight's remaining window: skipped without a claim, PENDING for
a drain with the room. A request skipped every night has a staged suite the window can never
hold; `ARIA_DRAIN_BUDGET_SECONDS` and the job's `timeout-minutes` move together
(`tests/test_state_lock_liveness_bound.py`).

A `sockets_pruned` governance row at orchestrator startup names `aria-sa-*` / `aria-hb-*` socket
directories a killed executor left behind (their listener is gone; the agent itself died with
its holder). Nothing to do.

If the git config is missing, read the mint's receipt: `PYTHONPATH=aria-kernel:. python3 -c "from
aria_kernel.gh_token_factory import mint_signing_key; print(mint_signing_key(cycle_id='diagnostic',
workspace_root='.').git_signing)"` — `configured=False` names the reason (`not_a_checkout`,
`git_unavailable`, `worktree_scope_unavailable:<why>`, `git_config_failed:<key>:rc=<n>`); revoke the
diagnostic key afterwards (`revoke_signing_key`).

## Rollback procedure

If V10.3-B reveals a structural issue with V3.1 that requires rolling the snowball branch back to the V3.1-A baseline:

```bash
# 1. Identify the rollback target.
git -C /var/aqua-saas log --oneline origin/snowball | head -15
# V3.1-A baseline = commit 4d9484c9 (pre-B/B2/B3/C2/D2).

# 2. Revert the V3.1-B through V3.1-D2 commits on snowball via
#    explicit revert commits (NOT a force push).
TARGET=4d9484c9
for sha in $(git rev-list ${TARGET}..origin/snowball); do
    git -C /var/aqua-saas revert --no-edit "$sha"
done
git -C /var/aqua-saas push origin snowball

# 3. Mark F-015-V31-B/B2/B3/C2/D2 status REOPENED in aria-findings.
```

CLAUDE.md mandates `--force` push is FORBIDDEN — use explicit revert commits so the audit trail captures both the original landing and the rollback.

## Commit policy for this runbook

Every operator execution of this runbook MUST:

1. Append a row to `aria-findings/F-015.json#F-015-V31-F` (smoke) OR `#F-015-V10-3-B` (endurance) with `executed_at` timestamp + metrics summary.
2. Commit + push the metadata-only update via:

```bash
git -C /var/aqua-saas add aria-findings/F-015.json
git -C /var/aqua-saas commit -m "chore(aria-findings): F-015-V10-3-B endurance executed YYYY-MM-DDTHH:MM:SSZ + metrics"
git -C /var/aqua-saas push origin snowball
```

3. Attach the operator-side log (`/tmp/v10-3-b-endurance-*.log`) to the finding's metadata block.

## Related runbooks

- `docs/runbooks/aria-github-app-setup.md` — Mode A GH App setup (V10.3-B Prerequisite A)
- `docs/runbooks/aria-ack-key-rotation.md` — operator ack-key rotation (separate concern)
- `docs/aria/CONTRACTS.md` — adapter + envelope contracts (V3.1 wire-up consumer)

## Audit trail

- 2026-05-19: Runbook authored as part of V3.1-F2 follow-up. Commits dc3c7fec → b338ff97 (V3.1 arc) closed inline.
- Pending: V3.1-F smoke executed by operator (target ≤ 2026-05-26).
- Pending: V10.3-B endurance executed by operator (target ≤ 2026-06-05).
