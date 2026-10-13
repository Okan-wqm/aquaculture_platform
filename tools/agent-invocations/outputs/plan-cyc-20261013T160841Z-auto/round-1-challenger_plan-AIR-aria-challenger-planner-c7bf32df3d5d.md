{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-38440808525",
  "claim_id": "claim_937bf780f5cd3e53",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:ad4d0c0796acf00f0143d3603cf4bc0d3faaf5d527964f0541920c86d20041e0",
    "agent_dispatch_model": "glm-5.3",
    "agent_subagent_type": "aria-challenger-planner",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-challenger-planner-c7bf32df3d5d\",\n  \"claim_id\": \"AIR-aria-challenger-planner-c7bf32df3d5d\",\n  \"agent_id\": \"aria-challenger-planner\",\n  \"role\": \"challenger_plan\",\n  \"status\": \"submitted\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"This plan's key_changes[0] answers the obligation's plan_description end to end: it diagnoses the failing 'Deploy Capacity Maintenance' job (line 54) and its SSH step (line 59) from the workflow file itself \u2014 the one unguarded, layout-dependent stage in the host-side chain is the git fetch + 'git rev-parse origin/main' resolution executed in /var/aqua-saas, which the file's own comment documents as a bare object store that keeps refs/heads and does not guarantee refs/remotes/origin/* \u2014 and lands a single-file architectural fix (explicit fetch-to-read ref contract plus stage-named ::error diagnostics) whose paths are exactly [\\\".github/workflows/deploy-capacity-maintenance.yml\\\"], matching the obligation's allowed paths.\",\n      \"evidence_refs\": [\n        \".github/workflows/deploy-capacity-maintenance.yml:59\",\n        \".github/workflows/deploy-capacity-maintenance.yml:54\",\n        \".github/workflows/deploy-capacity-maintenance.yml\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \".github/workflows/deploy-capacity-maintenance.yml:59\",\n    \".github/workflows/deploy-capacity-maintenance.yml:54\",\n    \".github/workflows/deploy-capacity-maintenance.yml\"\n  ],\n  \"plan_content\": {\n    \"schema_version\": 2,\n    \"title\": \"Deploy Capacity Maintenance: make the host-side main-resolution an explicit fetch-to-read ref contract with stage-named failures\",\n    \"summary\": \"The capacity-maintenance job fails at head 99689e46bd86eb980ca2bad74df3c6b072eb4e90 inside the single SSH step that runs the droplet-side control plane. Traversing the step's dependency chain backward from its consumers, every stage either cannot fail on valid input (env plumbing), fails with its own named ::error (the IMAGE_PREFIX regex guard), or runs guarded downstream scripts \u2014 except the newest, unguarded stage: 'git fetch --force --prune origin main' followed by 'git rev-parse origin/main' inside /var/aqua-saas, a repository the file itself documents as a bare object store where remote-tracking refs are not guaranteed to exist. The fix pins the fetch to write exactly the ref the script reads (+refs/heads/main:refs/remotes/origin/main), verifies it peels to a commit, and gives every remaining resolution stage a stage-named ::error so the next run log identifies the failing stage by name regardless of which assumption was wrong. The change touches only .github/workflows/deploy-capacity-maintenance.yml.\",\n    \"affected_surfaces\": [\n      {\n        \"paths\": [\".github/workflows/deploy-capacity-maintenance.yml\"]\n      }\n    ],\n    \"key_changes\": [\n      {\n        \"id\": \"kc-1-ref-contract\",\n        \"description\": \"In the capacity-maintenance SSH script, replace the implicit origin/main resolution with an explicit ref contract and stage-named failures: (1) 'if ! git fetch --force --prune origin \\\"+refs/heads/main:refs/remotes/origin/main\\\"; then echo \\\"::error::capacity-maintenance: git fetch of origin/main failed in /var/aqua-saas\\\"; exit 2; fi' so the fetch writes exactly the ref that is read, on any bare-store layout; (2) 'if ! TARGET_SHA=\\\"$(git rev-parse --verify \\\"refs/remotes/origin/main^{commit}\\\")\\\"; then echo \\\"::error::capacity-maintenance: refs/remotes/origin/main did not resolve to a commit after fetch\\\"; exit 2; fi' then 'export DEPLOY_SHA=\\\"${TARGET_SHA}\\\"'; (3) before the existing 'git show', add 'if ! git cat-file -e \\\"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\\\" 2>/dev/null; then echo \\\"::error::capacity-maintenance: scripts/deploy/deploy-paths.sh absent at ${TARGET_SHA}\\\"; exit 2; fi'. Leave the IMAGE_PREFIX derivation and regex guard, the install -d bootstrap, source of deploy-paths.sh, materialize_de...",
    "coverage_note": "Touched path is a GitHub workflow YAML: no Nx project, event-contract subscriber, or entity/migration node exists in its impact closure, so coverage.waivers is empty.",
    "independence_note": "Challenger lens applied: read from the consumer/contract end (capacity-preflight consumer, droplet-capacity.sh contract, deploy-paths bootstrap, bare-store ref layout, env plumbing) backward to the changed step last; the primary plan was not seen. Excerpt verification: the three supplied excerpts (lines 1-116, 14-94, 19-99) overlap and are mutually consistent across their shared ranges, and their content is sufficient for every claim made; no additional file read was required, and no claim cites anything beyond the admissible evidence refs.",
    "runtime_attempt_ledger_hash": "sha256:78445bf08e0a4d9e770a9c8d369856903b86e717c81423e08311bb273a4945b7"
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
    "architectural_approach": "Ranking every stage of the failing step by how it can fail: the env plumbing cannot fail on valid input; the IMAGE_PREFIX derivation fails only through its own explicit regex ::error with a named cause; the downstream capacity scripts are invoked from a pinned immutable checkout. The one stage that is both unguarded and rests on a fresh layout assumption is the host-side SHA resolution: reading 'origin/main' presumes the bare store maintains refs/remotes/origin/*, but a bare clone or mirror keeps heads under refs/heads/*, and 'git fetch origin main' with no matching configured refspec writes only FETCH_HEAD \u2014 under 'set -euo pipefail' the subsequent 'git rev-parse origin/main' then aborts the whole step with a bare git error and no stage attribution. That is also the newest code path at this head, which fits a failure that begins at this head. The architectural fix is to make the fetch write exactly the ref the script reads (+refs/heads/main:refs/remotes/origin/main) and to peel-verify that ref to a commit, so the fetch/read pair cannot silently diverge on any store layout \u2014 the correct resolution becomes the zero-effort default (tier 2), and any residual store corruption surfaces as a named ::error instead of an anonymous abort. The FETCH_HEAD-only alternative was considered and rejected: FETCH_HEAD is shared mutable state that the deploy lane also writes, so a dedicated ref is the deterministic contract. The same change adds a git cat-file -e existence check for the deploy-paths helper so the last unguarded assumption in the chain is also stage-named.",
    "architectural_tier": 2,
    "context": "What this workflow does and why it matters, for someone seeing it cold: 'Deploy Capacity Maintenance' is the production droplet's capacity lane. Every 6 hours by schedule (or on manual dispatch) the job at line 54 runs one SSH step (line 59) that resolves the remote's current main on the host, bootstraps the canonical deploy checkout from that exact commit, and runs scripts/deploy/droplet-capacity.sh in report or gate mode (the scheduled default is the safe image GC gate). The file's own schedule comment explains the stakes: each production deploy pulls a fresh ~1.85GB image per service across 13 services, leaving the prior generation untagged; without this bounded sweep those generations accumulate until the deploy capacity-preflight gate blocks deploys. So the downstream surface of this lane failing is not just a red CI badge \u2014 it is every subsequent production deploy's capacity preflight, which starts failing again once disk pressure rebuilds. The reported failure is on head 99689e46bd86eb980ca2bad74df3c6b072eb4e90, and the only admissible evidence is the workflow file itself, so the diagnosis must come from reading the step's own dependency chain.",
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
        "description": "In the capacity-maintenance SSH script, replace the implicit origin/main resolution with an explicit ref contract and stage-named failures: (1) 'if ! git fetch --force --prune origin \"+refs/heads/main:refs/remotes/origin/main\"; then echo \"::error::capacity-maintenance: git fetch of origin/main failed in /var/aqua-saas\"; exit 2; fi' so the fetch writes exactly the ref that is read, on any bare-store layout; (2) 'if ! TARGET_SHA=\"$(git rev-parse --verify \"refs/remotes/origin/main^{commit}\")\"; then echo \"::error::capacity-maintenance: refs/remotes/origin/main did not resolve to a commit after fetch\"; exit 2; fi' then 'export DEPLOY_SHA=\"${TARGET_SHA}\"'; (3) before the existing 'git show', add 'if ! git cat-file -e \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\" 2>/dev/null; then echo \"::error::capacity-maintenance: scripts/deploy/deploy-paths.sh absent at ${TARGET_SHA}\"; exit 2; fi'. Leave the IMAGE_PREFIX derivation and regex guard, the install -d bootstrap, source of deploy-paths.sh, materialize_deploy_checkout, cd into DEPLOY_CHECKOUT_DIR, and the OPERATION case dispatch byte-identical.",
        "id": "kc-1-ref-contract",
        "imports": [],
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      }
    ],
    "plan_steps_detailed": [
      {
        "action": "Edit the SSH script in .github/workflows/deploy-capacity-maintenance.yml: after 'cd /var/aqua-saas', replace 'git fetch --force --prune origin main' with a guarded explicit-refspec fetch writing refs/remotes/origin/main, and replace 'TARGET_SHA=\"$(git rev-parse origin/main)\"' with a guarded 'git rev-parse --verify refs/remotes/origin/main^{commit}'. Exact replacement fragment: 'if ! git fetch --force --prune origin \"+refs/heads/main:refs/remotes/origin/main\"; then echo \"::error::capacity-maintenance: git fetch of origin/main failed in /var/aqua-saas\"; exit 2; fi' and 'if ! TARGET_SHA=\"$(git rev-parse --verify \"refs/remotes/origin/main^{commit}\")\"; then echo \"::error::capacity-maintenance: refs/remotes/origin/main did not resolve to a commit after fetch\"; exit 2; fi', keeping 'export DEPLOY_SHA=\"${TARGET_SHA}\"'.",
        "step": 1,
        "why": "Cause/effect: the fetch now writes the exact ref the read consumes, so no ambient repository configuration can make the read fail after a successful fetch; if the fetch itself fails, the log names the stage instead of aborting anonymously."
      },
      {
        "action": "Immediately before the existing 'git show \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\" > /var/lib/aqua/deploy/deploy-paths.sh' line, add: 'if ! git cat-file -e \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\" 2>/dev/null; then echo \"::error::capacity-maintenance: scripts/deploy/deploy-paths.sh absent at ${TARGET_SHA}\"; exit 2; fi'. Change nothing else in the script: IMAGE_PREFIX derivation and regex guard, install -d, source of deploy-paths.sh, materialize_deploy_checkout, cd into DEPLOY_CHECKOUT_DIR, and the OPERATION case dispatch stay byte-identical.",
        "step": 2,
        "why": "This converts the last unguarded host-side assumption (helper path exists at the resolved SHA) into a named, diagnosable failure, so whatever stage actually fails on the next run, the log identifies it by name."
      },
      {
        "action": "Run the declared validation commands; confirm the format gate accepts the edited YAML. The runtime proof is the next lane execution: an operator-dispatched run with operation=report either passes end to end or emits exactly one stage-named ::error identifying the true failing stage \u2014 either outcome is evidence that closes the diagnosis loop.",
        "step": 3,
        "why": "None of the executable gates runs the workflow itself, so the plan's verification story is explicit: static gates now, and the instrumented next run as the runtime witness."
      }
    ],
    "recursive_impact": "Traversal order (consumer end first, changed code last): (1) Consumers of this lane's effect \u2014 the deploy capacity-preflight gate that depends on the droplet staying under threshold, and operators reading run logs when it does not. If the lane fails silently or anonymously, disk pressure returns and deploys block, the exact failure class the schedule comment documents. (2) The step's dependency chain, backward from execution order: scripts/deploy/droplet-capacity.sh subcommands (report/gate with CAPACITY_GC_MODE, CAPACITY_DISK_USAGE_MODE, DEPLOY_SERVICES, FULL_DEPLOY) depend on the materialized checkout; the checkout depends on materialize_deploy_checkout and DEPLOY_CHECKOUT_DIR from scripts/deploy/deploy-paths.sh at the resolved SHA; that bootstrap depends on 'git show <SHA>:scripts/deploy/deploy-paths.sh'; the SHA depends on 'git rev-parse origin/main' after 'git fetch --force --prune origin main' inside /var/aqua-saas \u2014 which the file's own comment block describes as the persistent bare object store, not an executable working tree; and the env plumbing (OPERATION, FULL_DEPLOY, DEPLOY_SERVICES, IMAGE_REPOSITORY from github.repository) feeds all of it. (3) Machine impact closure of the touched path: a GitHub workflow YAML maps to no Nx project, no event-contract subscriber, and no entity/migration node \u2014 the closure is the file itself, so no coverage waivers are required.",
    "risks": [
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "mitigation": "The same change instruments every resolution stage with a stage-named ::error, so the next run's log names the true failing stage; the fix is therefore evidence-generating even where the primary hypothesis is wrong.",
        "risk_id": "R-1",
        "severity": "MEDIUM",
        "summary": "Root-cause diagnosis is derived from the workflow file alone; no run log was admissible evidence, so if the actual failure is elsewhere \u2014 for example missing DROPLET_* secrets in the production environment, deployment protection rules holding scheduled runs, or the 12m command_timeout exceeded by deep disk-usage scans \u2014 the refspec fix alone will not clear the red run."
      },
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "mitigation": "This lane only fetches and never mirror-pushes, the ref write is namespaced under refs/remotes/, and the file's concurrency group serializes this workflow's own runs; no consumer of refs/heads/* is affected.",
        "risk_id": "R-2",
        "severity": "LOW",
        "summary": "Writing refs/remotes/origin/main into a mirror-layout bare store is an additive ref write that other readers of /var/aqua-saas did not previously observe."
      },
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:54"
        ],
        "mitigation": "Stated plainly in the validation plan rather than left implicit: static gates land with the change, and the instrumented next run is the runtime witness; the added ::error lines exist precisely to make that witness legible.",
        "risk_id": "R-3",
        "severity": "LOW",
        "summary": "None of the declared validation commands executes the workflow, so YAML runtime validity is proven only by the next scheduled or dispatched run."
      }
    ],
    "rollback": "The change is a single-file edit with no infrastructure state mutation of its own \u2014 it only changes how refs are resolved before the existing bounded operations run. Rollback is 'git revert' of the one commit touching .github/workflows/deploy-capacity-maintenance.yml, restoring the exact prior script. Roll back only on evidence the new refspec fetch broke a previously-green path (e.g., a store hook rejecting ref writes); note that reverting also restores the currently-failing resolution behavior, so the revert decision needs the failing run's log, not just a red check.",
    "schema_version": 2,
    "summary": "The capacity-maintenance job fails at head 99689e46bd86eb980ca2bad74df3c6b072eb4e90 inside the single SSH step that runs the droplet-side control plane. Traversing the step's dependency chain backward from its consumers, every stage either cannot fail on valid input (env plumbing), fails with its own named ::error (the IMAGE_PREFIX regex guard), or runs guarded downstream scripts \u2014 except the newest, unguarded stage: 'git fetch --force --prune origin main' followed by 'git rev-parse origin/main' inside /var/aqua-saas, a repository the file itself documents as a bare object store where remote-tracking refs are not guaranteed to exist. The fix pins the fetch to write exactly the ref the script reads (+refs/heads/main:refs/remotes/origin/main), verifies it peels to a commit, and gives every remaining resolution stage a stage-named ::error so the next run log identifies the failing stage by name regardless of which assumption was wrong. The change touches only .github/workflows/deploy-capacity-maintenance.yml.",
    "title": "Deploy Capacity Maintenance: make the host-side main-resolution an explicit fetch-to-read ref contract with stage-named failures",
    "validation_commands": [
      {
        "cmd": "npx nx affected --target=test",
        "expected_exit": 0,
        "timeout_ms": 1800000
      },
      {
        "cmd": "npx nx affected --target=lint",
        "expected_exit": 0,
        "timeout_ms": 1200000
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
    "validation_plan": "Declared executable gates (all four from the canonical suite): npx nx affected --target=test; npx nx affected --target=lint; npm run type-check; node tools/quality/quality.mjs format check-changed \u2014 the format gate is the one that parses the changed YAML. These prove the edit is statically sound. The runtime proof, which no sandboxed command can provide, is the next execution of the lane: the scheduled run or a manual workflow_dispatch with operation=report (12m command budget, 15m job budget). Success criteria: exit 0 with the capacity report emitted; or a single stage-named ::error line (fetch / sha-resolve / helper-missing) that converts the following round's diagnosis from inference to observation."
  },
  "request_id": "AIR-aria-challenger-planner-c7bf32df3d5d",
  "role": "challenger_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        ".github/workflows/deploy-capacity-maintenance.yml:59",
        ".github/workflows/deploy-capacity-maintenance.yml:54",
        ".github/workflows/deploy-capacity-maintenance.yml"
      ],
      "id": "key-change-0",
      "note": "This plan's key_changes[0] answers the obligation's plan_description end to end: it diagnoses the failing 'Deploy Capacity Maintenance' job (line 54) and its SSH step (line 59) from the workflow file itself \u2014 the one unguarded, layout-dependent stage in the host-side chain is the git fetch + 'git rev-parse origin/main' resolution executed in /var/aqua-saas, which the file's own comment documents as a bare object store that keeps refs/heads and does not guarantee refs/remotes/origin/* \u2014 and lands a single-file architectural fix (explicit fetch-to-read ref contract plus stage-named ::error diagnostics) whose paths are exactly [\".github/workflows/deploy-capacity-maintenance.yml\"], matching the obligation's allowed paths.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
