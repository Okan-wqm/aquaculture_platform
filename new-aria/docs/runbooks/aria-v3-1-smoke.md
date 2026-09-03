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
    --challenger-timeout-seconds 300 \
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
    --challenger-timeout-seconds 600 \
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

Symptom: governance shows `commit_signature_unverified` rejections.

This means the V3.1-B-2 base64 delimiter encoding OR the V3.1-B-3 mint_signing_key git config wire is broken for some reason. STOP the run. Verify:

```bash
# Check the cycle's signing key on disk:
ls /var/aqua-saas/aria-debts/keys/
# Check git config:
git -C /var/aqua-saas config --local --get commit.gpgsign
# Expected: "true"
git -C /var/aqua-saas config --local --get gpg.ssh.allowedSignersFile
# Expected: path to .git/aria-allowed-signers
```

If the git config is missing, `mint_signing_key` failed silently. Re-run with `PYTHONPATH=aria-kernel:. python3 -c "from aria_kernel.gh_token_factory import mint_signing_key; print(mint_signing_key(cycle_id='diagnostic', workspace_root='.'))"` and trace.

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
