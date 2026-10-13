{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-38418908789",
  "claim_id": "claim_d93abc4b6b1b518a",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:ad4d0c0796acf00f0143d3603cf4bc0d3faaf5d527964f0541920c86d20041e0",
    "agent_dispatch_model": "glm-5.3",
    "agent_subagent_type": "aria-challenger-planner",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-challenger-planner-b6329f06ccb5\",\n  \"claim_id\": \"AIR-aria-challenger-planner-b6329f06ccb5\",\n  \"agent_id\": \"aria-challenger-planner\",\n  \"role\": \"challenger_plan\",\n  \"status\": \"submitted\",\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/plan-cyc-20261013T131952Z-auto/round-1-challenger_plan-AIR-aria-challenger-planner-b6329f06ccb5.md\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"key_changes[0] of this plan addresses the failing Deploy Capacity Maintenance job touching only .github/workflows/deploy-capacity-maintenance.yml: it replaces the bare-store-fragile 'git rev-parse origin/main' shorthand resolution with an explicit fully-qualified refspec fetch plus a fully-qualified ref read, so the step's SHA pin resolves regardless of the droplet store's remote-tracking configuration. The diagnosis derives from the workflow file alone \u2014 the only admissible evidence in this envelope (no run-log refs were supplied, and citing gh-run refs has been rejected historically); risk R1 records the residual wrong-locus possibility and the pre-landing log check that disposes of it.\",\n      \"evidence_refs\": [\".github/workflows/deploy-capacity-maintenance.yml:59\", \".github/workflows/deploy-capacity-maintenance.yml:54\"]\n    }\n  ],\n  \"evidence_refs\": [\n    \".github/workflows/deploy-capacity-maintenance.yml\",\n    \".github/workflows/deploy-capacity-maintenance.yml:54\",\n    \".github/workflows/deploy-capacity-maintenance.yml:59\"\n  ],\n  \"plan_content\": {\n    \"schema_version\": 2,\n    \"title\": \"Challenger plan: fix Deploy Capacity Maintenance SHA pinning \u2014 bare-store ref resolution in the SSH step script\",\n    \"summary\": \"The capacity-maintenance job fails in its single SSH step when it pins the target SHA: the script fetches 'main' into the droplet's bare object store with a shorthand refspec (which writes FETCH_HEAD only, since bare stores carry no remote.origin.fetch refspec to update opportunistically) and then resolves the 'origin/main' shorthand, which depends on remote-tracking refs the store does not maintain; under 'set -euo pipefail' the step exits before checkout bootstrap and the 6-hourly GC lane fails on every scheduled and manual run. The fix, entirely inside the one allowed file, makes SHA resolution configuration-independent: fetch with the fully-qualified refspec '+refs/heads/main:refs/remotes/origin/main' and read 'refs/remotes/origin/main', so the ref written and the ref read are the same name in adjacent commands. This is tier 2 \u2014 correct resolution becomes the zero-effort default with no reliance on undocumented store state. Residual risk: run logs are not admissible evidence here, so if the observed failure sits past bootstrap (inside scripts/deploy/droplet-capacity.sh at the target commit, or at the SSH command_timeout) the fix locus is outside allowed_scope and the round must widen scope instead of landing this edit.\",\n    \"affected_surfaces\": [\n      { \"paths\": [\".github/workflows/deploy-capacity-maintenance.yml\"] }\n    ],\n    \"key_changes\": [\n      {\n        \"id\": \"kc-fix-sha-pin-001\",\n        \"description\": \"Root-cause fix in the capacity-maintenance step's script block (the step whose name begins 'Run capacity operation through production deploy control plane'). Replace the two lines 'git fetch --force --prune origin main' and 'TARGET_SHA=\\\"$(git rev-parse origin/main)\\\"' with 'git fetch --force --prune origin +refs/heads/main:refs/remotes/origin/main' and 'TARGET_SHA=\\\"$(git rev-parse refs/remotes/origin/main)\\\"'. Effect: the fetch explicitly writes the fully-qualified remote-tracking ref and the pin reads that same fully-qualified ref, so SHA resolution cannot depend on the bare store's ambient refspec configuration; 'cd /var/aqua-saas', the DEPLOY_SHA export, and everything after (install -d /var...",
    "runtime_attempt_ledger_hash": "sha256:121d81a6de386eee87a84f0d850bfe2c53de0f11ed87cd64c91b0f09fb8edfb5"
  },
  "evidence_refs": [
    ".github/workflows/deploy-capacity-maintenance.yml",
    ".github/workflows/deploy-capacity-maintenance.yml:54",
    ".github/workflows/deploy-capacity-maintenance.yml:59"
  ],
  "plan_content": {
    "affected_surfaces": [
      {
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      }
    ],
    "architectural_approach": "Defect chain, stated as cause and effect: the script does 'cd /var/aqua-saas' \u2014 the file's own comment documents this is a bare object store, not a working tree \u2014 then 'git fetch --force --prune origin main'. A shorthand refspec fetch writes FETCH_HEAD only; a bare clone has no configured remote.origin.fetch refspec, so no opportunistic remote-tracking update creates or refreshes refs/remotes/origin/main. The next line, 'TARGET_SHA=\"$(git rev-parse origin/main)\"', resolves the 'origin/main' shorthand against exactly those remote-tracking refs \u2014 which the store does not guarantee to exist. Under 'set -euo pipefail' that resolution failure exits the step before checkout bootstrap, failing every scheduled and dispatched run identically. Even if the store happens to carry local configuration that makes the shorthand resolve today, depending on undocumented store state is itself the defect. Fix, tier 2 (make the correct behaviour the zero-effort default): fetch with the fully-qualified refspec '+refs/heads/main:refs/remotes/origin/main' and read 'refs/remotes/origin/main' \u2014 the write and the read name the identical fully-qualified ref in adjacent commands, so correct pinning requires no operator effort and no store-side setup, and the failure mode has no ambient state left to depend on.",
    "architectural_tier": 2,
    "context": "What this lane is and why the failure matters: 'Deploy Capacity Maintenance' is the production droplet's 6-hourly capacity lane. Each production deploy pulls a fresh image per service (~1.85GB x 13) and leaves the prior generation untagged; this workflow's safe-image-gc keeps the droplet under the capacity-preflight threshold so deploys do not block \u2014 the workflow's own header names run #695 / 28332208818 / 28330781676 as the historic blocked-deploy outcome. The job (line 54) has one SSH step (line 59) that must: derive and validate a GHCR image prefix from github.repository (INFRA-CRITICAL-085: no dispatch input names a release, image, registry or repository), resolve the remote's current main to a pinned SHA on the droplet's bare object store, bootstrap the immutable deploy checkout from that SHA, and run scripts/deploy/droplet-capacity.sh from it. It is failing on head 99689e46bd86eb980ca2bad74df3c6b072eb4e90. The task: diagnose the root cause and land the architectural fix touching only this workflow file. If it is skipped or mis-fixed, untagged generations accumulate until production deploys are capacity-blocked \u2014 the exact outage class this lane exists to prevent; the downstream surface is the deploy control plane's capacity preflight and the droplet's disk headroom.",
    "evidence_refs": [
      ".github/workflows/deploy-capacity-maintenance.yml:59",
      ".github/workflows/deploy-capacity-maintenance.yml:54",
      ".github/workflows/deploy-capacity-maintenance.yml"
    ],
    "key_changes": [
      {
        "description": "Root-cause fix in the capacity-maintenance step's script block (the step whose name begins 'Run capacity operation through production deploy control plane'). Replace the two lines 'git fetch --force --prune origin main' and 'TARGET_SHA=\"$(git rev-parse origin/main)\"' with 'git fetch --force --prune origin +refs/heads/main:refs/remotes/origin/main' and 'TARGET_SHA=\"$(git rev-parse refs/remotes/origin/main)\"'. Effect: the fetch explicitly writes the fully-qualified remote-tracking ref and the pin reads that same fully-qualified ref, so SHA resolution cannot depend on the bare store's ambient refspec configuration; 'cd /var/aqua-saas', the DEPLOY_SHA export, and everything after (install -d /var/lib/aqua/deploy, git show of deploy-paths.sh, materialize_deploy_checkout, the OPERATION case block) stay byte-identical.",
        "id": "kc-fix-sha-pin-001",
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Adjacent hardening in the same script block, same file: immediately after 'export DEPLOY_SHA=\"${TARGET_SHA}\"' add 'printf \"capacity lane pinned to %s\\n\" \"${DEPLOY_SHA}\"' so the resolved pin is visible in the job log for triage, and add a short comment above the fetch stating the invariant \u2014 the store is bare and carries no remote-tracking configuration guarantee, so the lane must fetch and read the same fully-qualified ref \u2014 so a future editor cannot silently regress to shorthand resolution.",
        "id": "kc-hardening-observability-001",
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      }
    ],
    "plan_steps_detailed": [
      "1. Apply key_changes[0]: in .github/workflows/deploy-capacity-maintenance.yml, inside the 'script: |' block of the capacity-maintenance step, replace 'git fetch --force --prune origin main' with 'git fetch --force --prune origin +refs/heads/main:refs/remotes/origin/main' and replace 'TARGET_SHA=\"$(git rev-parse origin/main)\"' with 'TARGET_SHA=\"$(git rev-parse refs/remotes/origin/main)\"'. Nothing else in the script changes.",
      "2. Apply key_changes[1] in the same script block: add the pinned-SHA log line right after 'export DEPLOY_SHA=\"${TARGET_SHA}\"' and the bare-store invariant comment above the fetch line.",
      "3. Confirm the rest of the file is byte-identical after the edit: the schedule cron, all three workflow_dispatch inputs, permissions (contents: read), the concurrency group with cancel-in-progress: false, the pinned appleboy/ssh-action SHA, command_timeout: 12m, the envs passthrough list, the IMAGE_PREFIX derivation and regex guard, the checkout bootstrap, and the OPERATION case block.",
      "4. Local demonstration the implementer can run before landing (not a declared validation command): 'git init --bare /tmp/s.git && git -C /tmp/s.git fetch <repo-url> +refs/heads/main:refs/remotes/origin/main && git -C /tmp/s.git rev-parse refs/remotes/origin/main' \u2014 and observe that 'git -C /tmp/s.git rev-parse origin/main' fails on the same pristine bare store, reproducing the defect class the edit removes."
    ],
    "recursive_impact": "Read backward from the consumers, not forward from the code: (1) the production deploy capacity-preflight consumes the disk headroom this lane maintains \u2014 a failing lane re-opens the #695 blocked-deploy class; (2) operators invoke the three workflow_dispatch operations (report / safe-image-gc / gate) whose input contract must keep naming no release, image, registry or repository (INFRA-CRITICAL-085); (3) DEPLOY-HIGH-015 requires the lane to execute from the immutable pinned checkout, never from the bare store; (4) the deploy invariant suite landed with the pinned-checkout fix exercises the no-checkout boundary. The prescribed edit changes only how the pin's SHA is resolved \u2014 same value (remote main's commit), same downstream bootstrap \u2014 so contracts (2)-(4) are untouched and (1) is restored when the lane runs green. No NATS event contract, no DB entity or migration surface, and no frontend module consumes this file; the recursive blast radius is the droplet-side deploy control plane driven by this single step.",
    "risks": [
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59",
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "id": "R1",
        "recommendation": "Before landing, the implementer must read the failing run's step output and confirm the death occurs at the fetch/rev-parse stage (error text of the class 'unknown revision' / 'ambiguous argument origin/main'); if the run dies past bootstrap, stop and re-plan with widened scope rather than landing this edit.",
        "severity": "HIGH",
        "summary": "Diagnosis is static-file-only: the admissible evidence set contains no run log, so the failing step's actual death point is inferred from the workflow text, not observed. If the real failure sits past checkout bootstrap \u2014 inside scripts/deploy/droplet-capacity.sh at TARGET_SHA, at the 12m SSH command_timeout, or in the sourced deploy-paths.sh contract \u2014 the root cause is outside allowed_scope (this workflow file only) and key-change-0 cannot be satisfied without widening scope."
      },
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "id": "R2",
        "recommendation": "Keep the bootstrap sequence byte-identical to the current step; treat any helper-contract change as its own separately scoped change with its own evidence.",
        "severity": "MEDIUM",
        "summary": "The script sources deploy-paths.sh from TARGET_SHA and depends on materialize_deploy_checkout and DEPLOY_CHECKOUT_DIR being defined by it; if the target commit's helper diverges, the step dies at 'cd \"${DEPLOY_CHECKOUT_DIR}\"' under set -u \u2014 a locus a workflow-file-only change cannot fix."
      },
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "id": "R3",
        "recommendation": "When error surfacing matters, prefix remote log lines with a stable grep-able token instead of relying on ::error:: annotation rendering.",
        "severity": "LOW",
        "summary": "'echo \"::error::...\"' inside the SSH-executed script does not render as a GitHub Actions annotation, because workflow commands are interpreted by the runner, not across the SSH boundary; failure messages from the remote land only in the raw log."
      }
    ],
    "rollback": "Single-file revert of the one commit carrying the two script edits ('git revert' of that commit). Nothing persisted needs unwinding: the droplet store is only fetched into (refs/remotes/origin/main is force-rewritten by every run), the /var/lib/aqua/deploy bootstrap is unchanged, and no input, permission, or action pin moved. The previous behaviour \u2014 shorthand resolution dependent on store configuration \u2014 returns exactly as it was, including its failure mode.",
    "schema_version": 2,
    "summary": "The capacity-maintenance job fails in its single SSH step when it pins the target SHA: the script fetches 'main' into the droplet's bare object store with a shorthand refspec (which writes FETCH_HEAD only, since bare stores carry no remote.origin.fetch refspec to update opportunistically) and then resolves the 'origin/main' shorthand, which depends on remote-tracking refs the store does not maintain; under 'set -euo pipefail' the step exits before checkout bootstrap and the 6-hourly GC lane fails on every scheduled and manual run. The fix, entirely inside the one allowed file, makes SHA resolution configuration-independent: fetch with the fully-qualified refspec '+refs/heads/main:refs/remotes/origin/main' and read 'refs/remotes/origin/main', so the ref written and the ref read are the same name in adjacent commands. This is tier 2 \u2014 correct resolution becomes the zero-effort default with no reliance on undocumented store state. Residual risk: run logs are not admissible evidence here, so if the observed failure sits past bootstrap (inside scripts/deploy/droplet-capacity.sh at the target commit, or at the SSH command_timeout) the fix locus is outside allowed_scope and the round must widen scope instead of landing this edit.",
    "title": "Challenger plan: fix Deploy Capacity Maintenance SHA pinning \u2014 bare-store ref resolution in the SSH step script",
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
        "cmd": "npm run type-check",
        "expected_exit": 0,
        "timeout_ms": 900000
      },
      {
        "cmd": "node tools/quality/quality.mjs format check-changed",
        "expected_exit": 0,
        "timeout_ms": 300000
      }
    ],
    "validation_plan": "Declarable suite, exact canonical spellings: 'npx nx affected --target=test', 'npx nx affected --target=lint', 'npm run type-check', 'node tools/quality/quality.mjs format check-changed'. A workflow-file-only edit adds no nx project-graph edges, so affected:test / affected:lint exercise the existing deploy invariant suite only insofar as other changes place it in the affected set; the format gate is the direct automated check over the changed file. The functional proof is the next scheduled run (every 6h) getting past SHA pinning into checkout bootstrap and the capacity stage \u2014 that observation is operator-side run-log evidence and is deliberately NOT cited by this agent, because run-log refs are not in this envelope's admissible evidence set (a prior challenger submission was rejected for exactly that citation class)."
  },
  "request_id": "AIR-aria-challenger-planner-b6329f06ccb5",
  "role": "challenger_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        ".github/workflows/deploy-capacity-maintenance.yml:59",
        ".github/workflows/deploy-capacity-maintenance.yml:54"
      ],
      "id": "key-change-0",
      "note": "key_changes[0] of this plan addresses the failing Deploy Capacity Maintenance job touching only .github/workflows/deploy-capacity-maintenance.yml: it replaces the bare-store-fragile 'git rev-parse origin/main' shorthand resolution with an explicit fully-qualified refspec fetch plus a fully-qualified ref read, so the step's SHA pin resolves regardless of the droplet store's remote-tracking configuration. The diagnosis derives from the workflow file alone \u2014 the only admissible evidence in this envelope (no run-log refs were supplied, and citing gh-run refs has been rejected historically); risk R1 records the residual wrong-locus possibility and the pre-landing log check that disposes of it.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
