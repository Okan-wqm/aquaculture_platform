{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-37785407758",
  "claim_id": "claim_85e6e86cdb4e7f72",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:151414eb44dd797050a8bd5446c460165e7a7d2980e4c18de2505b73a6d9ff7a",
    "agent_dispatch_model": "glm-5.3",
    "agent_subagent_type": "aria-challenger-planner",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-challenger-planner-51f7a34af7a0\",\n  \"claim_id\": \"AIR-aria-challenger-planner-51f7a34af7a0\",\n  \"agent_id\": \"aria-challenger-planner\",\n  \"role\": \"challenger_plan\",\n  \"status\": \"submitted\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"This plan's key_changes[0] is the diagnosis plus architectural fix for the failing 'Deploy Capacity Maintenance' lane on head 73d8b2133f10b4af7473e573864c2ea3ddef6efc, touching only .github/workflows/deploy-capacity-maintenance.yml. Root cause class derived independently from the file's own structure: the lane executes identity validation, target-SHA resolution, checkout bootstrap, bounded image-GC, deep capacity scan and gate verdict inside ONE SSH step under one shared 12m command_timeout, so bootstrap faults, SSH-budget exhaustion and capacity-alarm gate exits all collapse into the same undifferentiated red run; the fix stages and separately budgets each class within the same file.\",\n      \"evidence_refs\": [\".github/workflows/deploy-capacity-maintenance.yml:59\", \".github/workflows/deploy-capacity-maintenance.yml:54\"]\n    }\n  ],\n  \"evidence_refs\": [\n    \".github/workflows/deploy-capacity-maintenance.yml:59\",\n    \".github/workflows/deploy-capacity-maintenance.yml:54\",\n    \".github/workflows/deploy-capacity-maintenance.yml\"\n  ],\n  \"plan_content\": {\n    \"schema_version\": 2,\n    \"title\": \"Stage-split Deploy Capacity Maintenance: named, separately-budgeted SSH stages plus fail-closed runner-side error relay\",\n    \"summary\": \"The scheduled capacity lane runs its entire contract \u2014 image-prefix validation, remote-main SHA resolution, immutable-checkout bootstrap, bounded image GC, deep disk scan and gate verdict \u2014 inside a single SSH step under a single 12-minute budget, so three distinct failure classes (bootstrap/operational, budget exhaustion, capacity-alarm gate exit) produce one undifferentiated red CI run, and the script's ::error:: diagnostics emitted remote-side of SSH never reliably render as GitHub annotations. The plan restructures the lane inside the one allowed file into two named stages that hand off state via /var/lib/aqua/deploy, gives each stage its own command_timeout whose sum fits the 15-minute job cap, and adds a fail-closed runner-side relay that converts remote sentinel lines and nonzero exits into real annotations and step failures. Gate and GC exit semantics are preserved verbatim \u2014 no signal is suppressed; what changes is that the failing step's name and budget isolate the failure class at CI time. The INFRA-CRITICAL-085 input posture, the pinned action SHA, permissions: contents: read, and the deploy-paths.sh bootstrap contract are all reused unchanged.\",\n    \"affected_surfaces\": [\n      { \"paths\": [\".github/workflows/deploy-capacity-maintenance.yml\"] }\n    ],\n    \"key_changes\": [\n      {\n        \"id\": \"kc-1\",\n        \"description\": \"Diagnose and fix the failing lane: root cause is the monolithic step at .github/workflows/deploy-capacity-maintenance.yml:59 collapsing bootstrap faults, 12m shared-budget exhaustion, and gate-exit capacity alarms into one opaque red run. Split it into Stage A 'Resolve target + bootstrap immutable checkout' (IMAGE_PREFIX regex, git fetch/rev-parse, git show + source of deploy-paths.sh, materialize_deploy_checkout, then atomically persist DEPLOY_SHA/DEPLOY_CHECKOUT_DIR/IMAGE_PREFIX to /var/lib/aqua/deploy/capacity-maintenance.env) and Stage B 'Run capacity maintenance (<operation>)' (the existing case dispatch verbatim, sourcing the env file first). Per-stage command_timeout 3m + 11m = 14m under the 15m timeout-minutes cap, arithmetic documented in comments.\",\n        \"paths\": [\".github/workflows/deploy-capacity-maintenance.yml\"]\n      },\n      {\n        \"id\": \"kc-2\",\n        \"description\": \"Add a fail-closed runner-side relay after each SSH stage: capture the action's output, propagate the remote exit code as the st...",
    "evidence_check": "All three excerpts are mutually consistent (the 1-116 excerpt supersedes the 14-94 and 19-99 windows); excerpt content was sufficient for every claim in this plan, so no file read was required.",
    "runtime_attempt_ledger_hash": "sha256:1d65e3994eb19aead9153930fb96fcaf80a86c5bf381c57bc51853aedca428a5",
    "traversal": "Consumer-backward per challenger discipline: CI run surface and job/step contract (lines 54-59) first, then the remote script contract (bootstrap, case dispatch, budget pair), then the dispatch input contract; the changed code history was read last as orientation only."
  },
  "evidence_refs": [
    ".github/workflows/deploy-capacity-maintenance.yml:59",
    ".github/workflows/deploy-capacity-maintenance.yml:54",
    ".github/workflows/deploy-capacity-maintenance.yml"
  ],
  "plan_content": {
    "affected_surfaces": [
      {
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      }
    ],
    "architectural_approach": "Tier 3 (make it detectable). A single workflow file cannot structurally prevent host-side runtime faults (tier 1) or make correct host state automatic (tier 2) \u2014 those live in the droplet and the scripts beyond this file's authority. What the file CAN do structurally is guarantee every failure class is named, separately bounded, and surfaced as a first-class CI signal. Concretely: split the monolithic SSH step into Stage A (resolve + bootstrap) and Stage B (maintenance dispatch), hand off DEPLOY_SHA/DEPLOY_CHECKOUT_DIR/IMAGE_PREFIX through an atomically-written env file in /var/lib/aqua/deploy, assign per-stage command_timeout values (3m + 11m) whose documented sum stays under the 15m job cap so one class's budget no longer consumes another's, name steps with expressions so the run shows the actual operation, and relay remote sentinel output and exit codes into real runner-side annotations with fail-closed semantics (nonzero remote exit or relayed ::error:: both fail the step). The same runner, secrets, pinned action SHA, environment gate, concurrency group, and permissions are reused; nothing about gate or GC exit semantics is softened \u2014 a capacity alarm remains a failing outcome, now distinguishable from a machinery fault by which stage failed.",
    "architectural_tier": 3,
    "context": "What this lane does and why the failure is opaque: every 6h (cron, line 15) or on dispatch, one SSH step (line 59) validates the GHCR image prefix, resolves remote main to a SHA on the droplet, bootstraps the canonical immutable checkout via scripts/deploy/deploy-paths.sh, then runs scripts/deploy/droplet-capacity.sh (report, or GC+gate for safe-image-gc) \u2014 all under one command_timeout: 12m inside timeout-minutes: 15. Work backward from the consumer \u2014 the operator staring at a red run on head 73d8b213 \u2014 and the defect is structural: bootstrap faults (fetch auth, rev-parse, unbound DEPLOY_CHECKOUT_DIR under set -u), budget exhaustion (the header's own history records SSH-budget exhaustion as the recurring class, with host contention severe enough that wall-clock test assertions were removed), and capacity-alarm gate exits (nonzero by design when the droplet stays over threshold after a bounded GC pass) are indistinguishable in the run result. The script's ::error:: lines execute on the remote side of the SSH session, so they surface only as buried log text, not as run annotations. If skipped, the next red run again names no class and the one-fix-per-recurrence pattern continues. Downstream surfaces affected: the scheduler/dispatch input contract (unchanged), the droplet's deploy control plane and capacity-preflight gate (semantics preserved), and operator diagnosis of CI runs (the surface this plan fixes). Evidence: the file's step/job structure at lines 54 and 59, the cron at line 15, the OPERATION fallback expression, the 12m/15m budget pair, and the case dispatch mapping safe-image-gc and gate to the same gate invocation.",
    "coverage": {
      "waivers": []
    },
    "evidence_refs": [
      ".github/workflows/deploy-capacity-maintenance.yml:59",
      ".github/workflows/deploy-capacity-maintenance.yml:54",
      ".github/workflows/deploy-capacity-maintenance.yml"
    ],
    "key_changes": [
      {
        "description": "Diagnose and fix the failing lane: root cause is the monolithic step at .github/workflows/deploy-capacity-maintenance.yml:59 collapsing bootstrap faults, 12m shared-budget exhaustion, and gate-exit capacity alarms into one opaque red run. Split it into Stage A 'Resolve target + bootstrap immutable checkout' (IMAGE_PREFIX regex, git fetch/rev-parse, git show + source of deploy-paths.sh, materialize_deploy_checkout, then atomically persist DEPLOY_SHA/DEPLOY_CHECKOUT_DIR/IMAGE_PREFIX to /var/lib/aqua/deploy/capacity-maintenance.env) and Stage B 'Run capacity maintenance (<operation>)' (the existing case dispatch verbatim, sourcing the env file first). Per-stage command_timeout 3m + 11m = 14m under the 15m timeout-minutes cap, arithmetic documented in comments.",
        "id": "kc-1",
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Add a fail-closed runner-side relay after each SSH stage: capture the action's output, propagate the remote exit code as the step's exit code, and re-emit any remote ::error:: sentinel lines as genuine runner-side echo '::error::' annotations (remote-side workflow-command output embedded in the SSH action's log stream is not reliably parsed today). Relay fails the step on nonzero remote exit AND on relayed error lines; use expression-based step names (operation fallback pattern already used for OPERATION) so the run log names the actual operation executed.",
        "id": "kc-2",
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Document in the workflow comments the three failure classes, the per-stage budget arithmetic, and the class each stage name identifies, so the next red run is diagnosable directly from the failing step name; keep permissions contents:read, the pinned appleboy/ssh-action SHA, the concurrency group, the environment gate, and the INFRA-CRITICAL-085 input posture (no dispatch input names an image, registry, release or repository) unchanged.",
        "id": "kc-3",
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      }
    ],
    "plan_steps_detailed": [
      "1. In .github/workflows/deploy-capacity-maintenance.yml, replace the single step at line 59 with Stage A 'Resolve target + bootstrap immutable checkout': same appleboy/ssh-action pin, same env wiring; the remote script runs set -euo pipefail, the IMAGE_PREFIX derivation and regex check, cd /var/aqua-saas, git fetch --force --prune origin main, TARGET_SHA resolution, install -d /var/lib/aqua/deploy, git show + source of deploy-paths.sh, materialize_deploy_checkout, then writes DEPLOY_SHA/DEPLOY_CHECKOUT_DIR/IMAGE_PREFIX to /var/lib/aqua/deploy/capacity-maintenance.env via write-temp-then-mv. Set this stage's command_timeout to 3m.",
      "2. Add Stage B 'Run capacity maintenance (${{ inputs.operation || \\'safe-image-gc\\' }})': sources /var/lib/aqua/deploy/capacity-maintenance.env, cds to DEPLOY_CHECKOUT_DIR, and executes the existing case dispatch verbatim (report arm; safe-image-gc | gate arm with CAPACITY_GC_MODE=auto CAPACITY_DISK_USAGE_MODE=deep; unsupported-operation arm). Set command_timeout to 11m; document in comments that 3m + 11m = 14m leaves the stage sum under the job's 15m timeout-minutes.",
      "3. Add a fail-closed relay to each stage: capture the SSH action output, propagate the remote exit code as the step exit code, and re-emit any remote ::error:: sentinel lines as runner-side echo '::error::title=<stage>::\u2026' annotations. The relay fails on nonzero remote exit AND on any relayed error line \u2014 a relay that could mask a remote failure would be a suppression defect.",
      "4. Update the header comments to state the three failure classes (bootstrap/operational, per-stage budget exhaustion, capacity-alarm gate exit), which stage name identifies each, and the budget arithmetic; leave permissions, concurrency, environment, cron, inputs, and the action pin untouched."
    ],
    "recursive_impact": "Consumers traced backward: (1) the GitHub scheduler and dispatch UI \u2014 the three inputs (operation, full_deploy, deploy_services) and their defaults are untouched, preserving the INFRA-CRITICAL-085 posture that no input names a release, image, registry or repository; (2) the production droplet's deploy control plane \u2014 the bootstrap contract (git show TARGET_SHA:scripts/deploy/deploy-paths.sh, source, materialize_deploy_checkout, cd DEPLOY_CHECKOUT_DIR) is reused as-is, only re-homed in its own stage with state persisted under the already-created /var/lib/aqua/deploy; (3) scripts/deploy/droplet-capacity.sh \u2014 invoked exactly as today with the same env (CAPACITY_GC_MODE/CAPACITY_DISK_USAGE_MODE), so its bounded-GC and gate exit behavior is unchanged; (4) the deploy capacity-preflight gate that depends on this lane keeping the droplet under threshold between deploys \u2014 a gate failure still fails the job, so the alarm channel is preserved; (5) on-call operators reading CI runs \u2014 the improved surface. This path is not an nx project, emits no NATS events, and owns no DB entity, so the machine impact closure beyond the file itself is empty.",
    "risks": [
      {
        "id": "R-CH-01",
        "mitigation": "The stage split is class-agnostic: whichever class recurs, the next run names it via the failing stage and relayed annotations, converting every future recurrence into a one-look diagnosis; the plan claims tier 3 on exactly this basis.",
        "severity": "MEDIUM",
        "summary": "The exact signature of failing run ci-run-37782945896 is not in the admissible evidence set, so the diagnosis is a ranked class inference, not a log-confirmed fact; if the failure was purely host-state (droplet unreachable, secrets, environment protection), no fix inside this file applies."
      },
      {
        "id": "R-CH-02",
        "mitigation": "Relay is specified fail-closed: nonzero remote exit OR any relayed ::error:: line fails the step; validation includes the affected test suite that exercises the deploy lane's invariant boundary.",
        "severity": "MEDIUM",
        "summary": "A buggy relay could swallow a remote nonzero exit and turn a real failure green \u2014 a suppression-class defect the plan must not introduce."
      },
      {
        "id": "R-CH-03",
        "mitigation": "Both stages reuse the same pinned action SHA and secrets; the existing concurrency group (line 50) already serializes this workflow's own runs, so no interleaved state handoff is possible.",
        "severity": "LOW",
        "summary": "Two SSH sessions instead of one slightly increase per-run connection-failure surface."
      },
      {
        "id": "R-CH-04",
        "mitigation": "The handoff reuses the identical consumption pattern present in the current script (source then cd \"${DEPLOY_CHECKOUT_DIR}\" under set -u), so no new assumption about the helper is introduced; any mismatch surfaces as a named Stage A failure.",
        "severity": "LOW",
        "summary": "The Stage A to Stage B handoff depends on deploy-paths.sh exporting DEPLOY_CHECKOUT_DIR exactly as the current monolithic script already consumes it; a contract mismatch would fail Stage A visibly rather than silently."
      }
    ],
    "rollback": "Single-file revert: git revert of the one commit touching .github/workflows/deploy-capacity-maintenance.yml restores the prior monolithic step, budget pair and script verbatim. The only new persistent droplet state is /var/lib/aqua/deploy/capacity-maintenance.env, a small env file inside the directory the current script already creates with install -d; it is rewritten atomically on every Stage A run and is inert to the reverted workflow, so no host cleanup is required for rollback.",
    "schema_version": 2,
    "summary": "The scheduled capacity lane runs its entire contract \u2014 image-prefix validation, remote-main SHA resolution, immutable-checkout bootstrap, bounded image GC, deep disk scan and gate verdict \u2014 inside a single SSH step under a single 12-minute budget, so three distinct failure classes (bootstrap/operational, budget exhaustion, capacity-alarm gate exit) produce one undifferentiated red CI run, and the script's ::error:: diagnostics emitted remote-side of SSH never reliably render as GitHub annotations. The plan restructures the lane inside the one allowed file into two named stages that hand off state via /var/lib/aqua/deploy, gives each stage its own command_timeout whose sum fits the 15-minute job cap, and adds a fail-closed runner-side relay that converts remote sentinel lines and nonzero exits into real annotations and step failures. Gate and GC exit semantics are preserved verbatim \u2014 no signal is suppressed; what changes is that the failing step's name and budget isolate the failure class at CI time. The INFRA-CRITICAL-085 input posture, the pinned action SHA, permissions: contents: read, and the deploy-paths.sh bootstrap contract are all reused unchanged.",
    "title": "Stage-split Deploy Capacity Maintenance: named, separately-budgeted SSH stages plus fail-closed runner-side error relay",
    "validation_commands": [
      {
        "cmd": "npx nx affected --target=test",
        "expected_exit": 0,
        "timeout_ms": 1800000
      },
      {
        "cmd": "npx nx affected --target=lint",
        "expected_exit": 0,
        "timeout_ms": 900000
      },
      {
        "cmd": "node tools/quality/quality.mjs format check-changed",
        "expected_exit": 0,
        "timeout_ms": 300000
      }
    ],
    "validation_plan": "Declared commands, all from the operator-declared suite: (1) node tools/quality/quality.mjs format check-changed \u2014 proves the edited YAML passes the repository's enforced changed-file format gate; (2) npx nx affected --target=lint \u2014 proves the changed file passes the repository lint graph, which is where workflow/YAML lint surfaces if wired; (3) npx nx affected --target=test \u2014 proves the deploy invariant suite referenced by this lane's own history (the no-checkout boundary was made executable in tests when the pinned checkout landed) still passes with the restructured lane. Post-merge operator follow-up (not a declared validation command): one workflow_dispatch smoke run with operation=report to confirm Stage A/B handoff and annotation relay on the real droplet."
  },
  "request_id": "AIR-aria-challenger-planner-51f7a34af7a0",
  "role": "challenger_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        ".github/workflows/deploy-capacity-maintenance.yml:59",
        ".github/workflows/deploy-capacity-maintenance.yml:54"
      ],
      "id": "key-change-0",
      "note": "This plan's key_changes[0] is the diagnosis plus architectural fix for the failing 'Deploy Capacity Maintenance' lane on head 73d8b2133f10b4af7473e573864c2ea3ddef6efc, touching only .github/workflows/deploy-capacity-maintenance.yml. Root cause class derived independently from the file's own structure: the lane executes identity validation, target-SHA resolution, checkout bootstrap, bounded image-GC, deep capacity scan and gate verdict inside ONE SSH step under one shared 12m command_timeout, so bootstrap faults, SSH-budget exhaustion and capacity-alarm gate exits all collapse into the same undifferentiated red run; the fix stages and separately budgets each class within the same file.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
