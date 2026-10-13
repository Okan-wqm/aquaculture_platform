{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-38440808525",
  "claim_id": "claim_8c3b8f213ce94c51",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:bd533ad74bc9a9afbaeb8f0595cb782c8cbfc079742bb51010c70636497d8f24",
    "agent_dispatch_model": "glm-5.3",
    "agent_subagent_type": "aria-primary-planner",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-primary-planner-5abf63e0e69e\",\n  \"claim_id\": \"AIR-aria-primary-planner-5abf63e0e69e\",\n  \"agent_id\": \"aria-primary-planner\",\n  \"role\": \"primary_plan\",\n  \"status\": \"submitted\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"Revised key_changes[0] (id ci-run-38409794036-key-change-001) now carries the root-cause diagnosis and the exact guarded edit fragments for the failing step at line 59 \u2014 an explicit-refspec fetch writing refs/remotes/origin/main, a peel-verified rev-parse before DEPLOY_SHA export, and a git cat-file existence check for scripts/deploy/deploy-paths.sh \u2014 touching only .github/workflows/deploy-capacity-maintenance.yml, the sole path the obligation lists. The diagnosis is anchored in the file's own text: the script documents /var/aqua-saas as the persistent bare object store, a refspec-less 'git fetch origin main' writes only FETCH_HEAD there, and 'git rev-parse origin/main' then aborts the step anonymously under 'set -euo pipefail'. Everything else in the script stays byte-identical.\",\n      \"evidence_refs\": [\n        \".github/workflows/deploy-capacity-maintenance.yml:59\",\n        \".github/workflows/deploy-capacity-maintenance.yml\"\n      ]\n    },\n    {\n      \"id\": \"plan_contract:plan_architectural_tier_missing\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"plan_content.architectural_tier = 2 is claimed on the body with justification in plan_content.architectural_approach: the fetch writes exactly the ref the script reads (+refs/heads/main:refs/remotes/origin/main), so correct resolution becomes the zero-effort default on any bare-store layout, with stage-named ::error detection as a secondary property of the same change. Every plan_content.validation_commands entry names one of the four canonical-suite commands declared in this request's plan contract; key_changes[] carries the {id, description, paths, imports} shape with imports: [] since no TypeScript/JavaScript source is touched.\",\n      \"evidence_refs\": [\n        \".github/workflows/deploy-capacity-maintenance.yml:59\",\n        \".github/workflows/deploy-capacity-maintenance.yml\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \".github/workflows/deploy-capacity-maintenance.yml:59\",\n    \".github/workflows/deploy-capacity-maintenance.yml:54\",\n    \".github/workflows/deploy-capacity-maintenance.yml\"\n  ],\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/plan-cyc-20261013T160841Z-auto/round-2-primary_plan-AIR-aria-primary-planner-5abf63e0e69e.md\",\n  \"plan_content\": {\n    \"schema_version\": 2,\n    \"title\": \"Deploy Capacity Maintenance: make host-side main resolution an explicit fetch-to-read ref contract with stage-named failures\",\n    \"summary\": \"The capacity-maintenance lane fails at head 99689e46bd86eb980ca2bad74df3c6b072eb4e90 inside its single SSH step (line 59), and the workflow file itself names the one unguarded, layout-dependent stage in that step's chain: the script documents /var/aqua-saas as the persistent bare object store, yet resolves main via 'git fetch --force --prune origin main' followed by 'git rev-parse origin/main' \u2014 a read whose success depends on remote-tracking refs a bare store does not guarantee, so under 'set -euo pipefail' the read aborts the step with an anonymous git error. The revision pins the fetch to write exactly the ref the script reads (+refs/heads/main:refs/remotes/origin/main), verifies that ref peels to a commit before exporting DEPLOY_SHA, and gives every remaining resolution stage a stage-named ::error (fetch / sha-resolve / helper-missing) so the next lane run converts inference into observation whichever assumption was wrong. Only .github/workflows/deploy-capacity-maintenance.yml changes; the IMAGE_PREFIX guard, bootstrap, checkout materialization, and operation dispatch stay byte-identical. The four c...",
    "evidence_notes": "All claims rest on the workflow file excerpts carried in this request (lines 1-116, corroborating excerpts at lines 14-94 and 19-99; the fetch/rev-parse pair and the bare-store comment sit inside the step at line 59). The coverage-manifest ref arrived marked skipped=malformed_ref and is not a repo-resolvable path, so it is not cited; no impact_graph_refs entries exist, so no impact node is unknown.",
    "plan_document": "# Plan: Deploy Capacity Maintenance \u2014 explicit fetch-to-read ref contract with stage-named failures\n\n## Context\n\nCI reports the workflow 'Deploy Capacity Maintenance' failing at head 99689e46bd86eb980ca2bad74df3c6b072eb4e90. The job at line 54 is one SSH step (line 59) that resolves the remote's current main on the production droplet, bootstraps the canonical deploy checkout from that exact commit, and runs scripts/deploy/droplet-capacity.sh. The file's own schedule comment states the downstream stake: each production deploy pulls a fresh ~1.85GB image per service across 13 services, and without this lane's bounded sweep the untagged generations accumulate until the deploy capacity-preflight gate blocks production deploys. The round-1 cross-review rejected the previous primary body (no architectural_tier claim, no edit prescription); this revision supplies both, resolves CR-001..CR-005, and holds the edit to the single file the allowed scope names.\n\n## Recursive Impact\n\nNo impact_graph_refs entries accompany this request, so no impact node is unknown and nothing blocks dispatch. Tracing to the most extreme affected node, consumer end first: (1) operators reading run logs and the deploy capacity-preflight gate that depends on the droplet staying under threshold \u2014 an anonymously failing lane lets disk pressure rebuild until production deploys block, the failure class the file's own schedule comment documents. (2) Inside the step at line 59, backward from execution order: scripts/deploy/droplet-capacity.sh (report/gate with CAPACITY_GC_MODE, CAPACITY_DISK_USAGE_MODE, DEPLOY_SERVICES, FULL_DEPLOY) depends on the materialized checkout; that depends on materialize_deploy_checkout and DEPLOY_CHECKOUT_DIR from scripts/deploy/deploy-paths.sh at the resolved SHA; that bootstrap depends on `git show ${TARGET_SHA}:scripts/deploy/deploy-paths.sh`; the SHA depends on `git rev-parse origin/main` after `git fetch --force --prune origin main` inside /var/aqua-saas \u2014 which the script's own comment documents as the persistent bare object store, not an executable working tree; the env plumbing (OPERATION, FULL_DEPLOY, DEPLOY_SERVICES, IMAGE_REPOSITORY) feeds all of it and cannot fail on valid input, and the IMAGE_PREFIX derivation fails only through its own named regex ::error. The one stage that is both unguarded and rests on a layout assumption is that fetch/rev-parse pair. (3) Machine impact closure of a GitHub workflow YAML path: no Nx project, no NATS event-contract consumer, no entity/migration node \u2014 the closure is the file itself, so coverage.waivers is empty.\n\n## Architectural Approach\n\nTier 2 \u2014 the correct behaviour becomes the zero-effort default. The fetch is pinned to write exactly the ref the script reads (`+refs/heads/main:refs/remotes/origin/main`), so no ambient repository configuration or bare-store layout can make the read fail after a successful fetch; FETCH_HEAD was considered as the read target and rejected because it is shared mutable state on the deploy host, making a dedicated namespaced ref the deterministic contract. The diagnosis is grounded in the file's own text: the comment at the fetch documents /var/aqua-saas as a persistent bare object store, where remote-tracking refs are not guaranteed to exist or be updated by a refspec-less `git fetch origin main` that writes only FETCH_HEAD; under `set -euo pipefail` the subsequent `git rev-parse origin/main` then aborts the step with a bare git error and no stage attribution. Tier 1 is unavailable because no type system or compiler governs host-side git state inside a shell step. The same change adds tier-3 detection as a secondary property: every resolution stage (fetch / sha-resolve / helper-missing) emits a stage-named ::error, so the next run's log identifies the failing stage by name even where this diagnosis is wrong.\n\n## Plan Steps\n\n1. **Guarded explicit-refspec fetch** \u2014 after `cd /var/aqua-saas`, replace `git fetch --force --prune origin main` with `if ! git fetch --force --prune origin \"+refs/heads/main:refs/remotes/origin/main\"; then echo \"::error::capacity-maintenance: git fetch of origin/main failed in /var/aqua-saas\"; exit 2; fi`. The fetch now writes the exact ref the read consumes. [evidence: .github/workflows/deploy-capacity-maintenance.yml:59; satisfies key-change-0]\n2. **Peel-verified SHA resolution** \u2014 replace `TARGET_SHA=\"$(git rev-parse origin/main)\"` with `if ! TARGET_SHA=\"$(git rev-parse --verify \"refs/remotes/origin/main^{commit}\")\"; then echo \"::error::capacity-maintenance: refs/remotes/origin/main did not resolve to a commit after fetch\"; exit 2; fi`, keeping `export DEPLOY_SHA=\"${TARGET_SHA}\"`. [evidence: :59; satisfies key-change-0]\n3. **Helper existence check** \u2014 immediately before `git show \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\" > /var/lib/aqua/deploy/deploy-paths.sh`, add `if ! git cat-file -e \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\" 2>/dev/null; then echo \"::error::capacity-maintenance: scripts/deploy/deploy-paths.sh absent at ${TARGET_SHA}\"; exit 2; fi`. [evidence: :59; satisfies key-change-0]\n4. **Everything else byte-identical** \u2014 IMAGE_PREFIX derivation and regex guard, `install -d /var/lib/aqua/deploy`, the git show/source bootstrap, `materialize_deploy_checkout`, `cd \"${DEPLOY_CHECKOUT_DIR}\"`, and the OPERATION case dispatch are unchanged. [evidence: :59; satisfies key-change-0]\n5. **Validate** \u2014 run the four canonical gates; the next scheduled (cron '0 */6 * * *') or operator-dispatched run with operation=report is the runtime witness. [evidence: :54, :59; satisfies key-change-0 and plan_contract:plan_architectural_tier_missing]\n\n## Validation Plan\n\nStatic gates, all four from the canonical suite and all declared in plan_content.validation_commands: `npx nx affected --target=test`; `npx nx affected --target=lint`; `npm run type-check`; `node tools/quality/quality.mjs format check-changed` \u2014 the format gate is the one that parses the changed YAML. No sandboxed command executes the workflow, so the runtime proof is the lane's next execution. Success criteria: exit 0 with the capacity report emitted; or exactly one stage-named ::error (fetch / sha-resolve / helper-missing) naming the true failing stage \u2014 the second outcome converts the following round's diagnosis from inference to observation and is treated as new evidence, never as a silent verdict on the refspec change.\n\n## Rollback\n\nSingle-file edit, no infrastructure state mutation of its own. Rollback: `git revert --no-edit <the commit touching .github/workflows/deploy-capacity-maintenance.yml>` restores the prior script byte-for-byte. Revert only on evidence the new refspec fetch broke a previously-green path (e.g. a store hook rejecting refs/remotes/ writes); reverting also restores the currently-failing resolution behavior, so the decision needs the failing run's log, not just a red check.\n\n## Risks\n\n- **R-1 (MEDIUM)** \u2014 Diagnosis derives from the workflow file alone; no run log was admissible. Alternate causes visible in the same job (missing DROPLET_HOST/DROPLET_USER/DROPLET_SSH_KEY secrets, production-environment protection rules on the job at line 54, the 12m command_timeout exceeded) would survive the refspec fix. Containment: stage-named ::error instrumentation makes the next run evidence-generating; a still-red instrumented run is the following round's primary evidence. affected_files: [.github/workflows/deploy-capacity-maintenance.yml]; evidence: :59, :54; required_plan_changes: none beyond the committed instrumentation.\n- **R-2 (LOW)** \u2014 Writing refs/remotes/origin/main into the shared bare store is an additive ref write other readers did not previously observe. Containment: fetch-only lane, namespaced ref, concurrency group serializes this workflow's own runs. evidence: :59; required_plan_changes: none.\n- **R-3 (LOW)** \u2014 No declared validation command executes the workflow; runtime validity is proven by the next scheduled or dispatched run. Containment: stated in the Validation Plan; the ::error lines make that witness legible. evidence: :54; required_plan_changes: none.\n- **R-4 (LOW)** \u2014 Sibling deploy lanes resolving origin/main through an implicit refspec against the same bare store carry the same latent failure (CR-005). This cycle's allowed scope binds the edit to this one file; the sweep is recorded as a follow-up finding proposal in details.revision for operator routing through its own envelope. evidence: :59; required_plan_changes: none in this envelope.\n",
    "revision": {
      "addresses_review_risk_ids": [
        "CR-001",
        "CR-002",
        "CR-003",
        "CR-004",
        "CR-005"
      ],
      "resolutions": {
        "CR-001": "plan_content.architectural_tier = 2 is claimed on the body and justified in architectural_approach: the fetch writes exactly the ref the script reads, making correct resolution the zero-effort default on any bare-store layout, with stage-named ::error detection as a secondary property.",
        "CR-002": "key_changes[0] (id ci-run-38409794036-key-change-001, same id and paths the obligation names) now carries the root-cause hypothesis and the exact guarded edit fragments for the step at line 59; an implementer applying it exactly as prescribed receives a complete change prescription, not a restatement of the task.",
        "CR-003": "Every resolution stage (fetch / sha-resolve / helper-missing) emits a stage-named ::error, so the next lane run converts inference to observation; the Validation Plan and R-1 state that a still-red instrumented run is new evidence for the following round, never a silent verdict on the refspec change.",
        "CR-004": "affected_surfaces is authored as [{paths:[...]}], the summary is a four-sentence narrative distinct from the key-change text, and schema_version, validation_commands, and evidence_refs are canonical at the source \u2014 acceptance no longer depends on the ci_executor V8.4 normalizer wrapping flat strings.",
        "CR-005": "The edit stays inside the single-file allowed scope; the sibling-lane implicit-refspec sweep against /var/aqua-saas is recorded here as a follow-up finding proposal for operator routing through its own envelope, since this envelope writes no file besides its plan body."
      }
    },
    "runtime_attempt_ledger_hash": "sha256:198e0eb89626dd944f77f1dabd93cadedfbfda53e8661af95814de300f8e899e"
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
    "architectural_approach": "Tier 2 \u2014 make the correct behaviour the zero-effort default. The fetch is pinned to write exactly the ref the script reads (+refs/heads/main:refs/remotes/origin/main), so no ambient repository configuration or bare-store layout can make the read fail after a successful fetch; the FETCH_HEAD alternative was considered and rejected because FETCH_HEAD is shared mutable state on the deploy host, making a dedicated namespaced ref the deterministic contract. The diagnosis is grounded in the file's own text: the comment at the fetch documents /var/aqua-saas as a persistent bare object store, where remote-tracking refs are not guaranteed to exist or be updated by a refspec-less 'git fetch origin main' that writes only FETCH_HEAD; under 'set -euo pipefail' the subsequent 'git rev-parse origin/main' then aborts the step with a bare git error and no stage attribution. Tier 1 is unavailable because no type system or compiler governs host-side git state inside a shell step \u2014 the strongest structural prevention available is closing the write/read ref contract. The same change adds tier-3 detection as a secondary property: every resolution stage (fetch / sha-resolve / helper-missing) emits a stage-named ::error instead of an anonymous abort, so the next run's log identifies the failing stage by name even where this diagnosis is wrong.",
    "architectural_tier": 2,
    "context": "CI reports the workflow 'Deploy Capacity Maintenance' failing at head 99689e46bd86eb980ca2bad74df3c6b072eb4e90. The job at line 54 is one SSH step (line 59) that resolves the remote's current main on the production droplet, bootstraps the canonical deploy checkout from that exact commit, and runs scripts/deploy/droplet-capacity.sh. The file's own schedule comment states the downstream stake: each production deploy pulls a fresh ~1.85GB image per service across 13 services, and without this lane's bounded sweep the untagged generations accumulate until the deploy capacity-preflight gate blocks production deploys \u2014 so a failing lane is not a red badge, it is the next deploy's capacity preflight failing once disk pressure rebuilds. The round-1 cross-review rejected the previous primary body (no architectural_tier claim, no edit prescription); this revision supplies both, resolves CR-001..CR-005, and holds the edit to the single file the allowed scope names.",
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
        "description": "Fix the failing 'Deploy Capacity Maintenance' step (line 59) by replacing the implicit origin/main resolution in the SSH script with an explicit fetch-to-read ref contract and stage-named failures: (1) replace 'git fetch --force --prune origin main' with 'if ! git fetch --force --prune origin \"+refs/heads/main:refs/remotes/origin/main\"; then echo \"::error::capacity-maintenance: git fetch of origin/main failed in /var/aqua-saas\"; exit 2; fi'; (2) replace 'TARGET_SHA=\"$(git rev-parse origin/main)\"' with 'if ! TARGET_SHA=\"$(git rev-parse --verify \"refs/remotes/origin/main^{commit}\")\"; then echo \"::error::capacity-maintenance: refs/remotes/origin/main did not resolve to a commit after fetch\"; exit 2; fi', keeping 'export DEPLOY_SHA=\"${TARGET_SHA}\"'; (3) immediately before the existing 'git show \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\" > /var/lib/aqua/deploy/deploy-paths.sh' add 'if ! git cat-file -e \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\" 2>/dev/null; then echo \"::error::capacity-maintenance: scripts/deploy/deploy-paths.sh absent at ${TARGET_SHA}\"; exit 2; fi'. Root cause: the script's own comment documents /var/aqua-saas as the persistent bare object store; a refspec-less 'git fetch origin main' writes only FETCH_HEAD there, so 'git rev-parse origin/main' aborts under 'set -euo pipefail'. Leave the IMAGE_PREFIX derivation and regex guard, install -d, the git show/source bootstrap, materialize_deploy_checkout, cd into DEPLOY_CHECKOUT_DIR, and the OPERATION case dispatch byte-identical.",
        "id": "ci-run-38409794036-key-change-001",
        "imports": [],
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      }
    ],
    "plan_steps_detailed": [
      {
        "action": "In the SSH script of .github/workflows/deploy-capacity-maintenance.yml, after 'cd /var/aqua-saas', replace 'git fetch --force --prune origin main' with: if ! git fetch --force --prune origin \"+refs/heads/main:refs/remotes/origin/main\"; then echo \"::error::capacity-maintenance: git fetch of origin/main failed in /var/aqua-saas\"; exit 2; fi \u2014 so the fetch writes the exact ref the read consumes on any bare-store layout, and a failing fetch names its stage.",
        "step": 1,
        "why": "Cause/effect: the fetch now writes refs/remotes/origin/main itself, so the read no longer depends on ambient refspec configuration; if the fetch fails, the log names the stage instead of aborting anonymously under set -euo pipefail."
      },
      {
        "action": "Replace 'TARGET_SHA=\"$(git rev-parse origin/main)\"' with: if ! TARGET_SHA=\"$(git rev-parse --verify \"refs/remotes/origin/main^{commit}\")\"; then echo \"::error::capacity-maintenance: refs/remotes/origin/main did not resolve to a commit after fetch\"; exit 2; fi \u2014 and keep 'export DEPLOY_SHA=\"${TARGET_SHA}\"' unchanged.",
        "step": 2,
        "why": "Cause/effect: the read is restricted to the exact ref the fetch wrote and peel-verified to a commit, so a fetch/read divergence or store corruption surfaces as a named ::error rather than a bare rev-parse abort."
      },
      {
        "action": "Immediately before the existing 'git show \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\" > /var/lib/aqua/deploy/deploy-paths.sh' line, add: if ! git cat-file -e \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\" 2>/dev/null; then echo \"::error::capacity-maintenance: scripts/deploy/deploy-paths.sh absent at ${TARGET_SHA}\"; exit 2; fi",
        "step": 3,
        "why": "Cause/effect: the last unguarded host-side assumption (the helper path exists at the resolved SHA) becomes a named, diagnosable failure, so whatever stage fails on the next run, the log identifies it by name."
      },
      {
        "action": "Change nothing else in the script: the IMAGE_PREFIX derivation and regex guard, 'install -d /var/lib/aqua/deploy', the git show/source bootstrap, materialize_deploy_checkout, cd into DEPLOY_CHECKOUT_DIR, and the OPERATION case dispatch stay byte-identical.",
        "step": 4,
        "why": "Cause/effect: the edit is confined to the resolution stages the diagnosis indicts, so the diff is reviewable against the failure hypothesis and no bounded-sweep semantics shift."
      },
      {
        "action": "Run the four declared canonical validation commands; the runtime witness is the lane's next execution \u2014 the scheduled run (cron '0 */6 * * *') or an operator-dispatched run with operation=report.",
        "step": 5,
        "why": "Cause/effect: none of the executable gates runs the workflow itself, so the verification story is explicit \u2014 static gates now, and the instrumented next run as the runtime proof that either passes end to end or names exactly one failing stage."
      }
    ],
    "recursive_impact": "The request carries no impact_graph_refs entries, so no impact node is unknown and nothing blocks dispatch. Tracing to the most extreme affected node, consumer end first: (1) operators reading run logs and the deploy capacity-preflight gate that depends on the droplet staying under threshold \u2014 an anonymously failing lane lets disk pressure rebuild until production deploys block, the failure class the file's own schedule comment documents. (2) Inside the step at line 59, backward from execution order: scripts/deploy/droplet-capacity.sh (report/gate with CAPACITY_GC_MODE, CAPACITY_DISK_USAGE_MODE, DEPLOY_SERVICES, FULL_DEPLOY) depends on the materialized checkout; that depends on materialize_deploy_checkout and DEPLOY_CHECKOUT_DIR from scripts/deploy/deploy-paths.sh at the resolved SHA; that bootstrap depends on 'git show ${TARGET_SHA}:scripts/deploy/deploy-paths.sh'; the SHA depends on 'git rev-parse origin/main' after 'git fetch --force --prune origin main' inside /var/aqua-saas \u2014 which the script's own comment documents as the persistent bare object store, not an executable working tree; the env plumbing (OPERATION, FULL_DEPLOY, DEPLOY_SERVICES, IMAGE_REPOSITORY) feeds all of it and cannot fail on valid input, and the IMAGE_PREFIX derivation fails only through its own named regex ::error. The one stage that is both unguarded and rests on a fresh layout assumption is that fetch/rev-parse pair \u2014 also the newest code path at this head, fitting a failure that begins at this head. (3) Machine impact closure of a GitHub workflow YAML path: it maps to no Nx project, no NATS event-contract consumer, and no entity/migration node, so the closure is the file itself and coverage.waivers is empty.",
    "risks": [
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59",
          ".github/workflows/deploy-capacity-maintenance.yml:54"
        ],
        "required_plan_changes": "None beyond the committed instrumentation: the same change gives every resolution stage a stage-named ::error, so the next run's log names the true failing stage and a still-red instrumented run becomes the following round's primary evidence.",
        "risk_id": "R-1",
        "severity": "MEDIUM",
        "summary": "Root-cause diagnosis is derived from the workflow file alone; no run log was admissible evidence, so alternate causes visible in the same job \u2014 missing DROPLET_HOST/DROPLET_USER/DROPLET_SSH_KEY secrets, production-environment protection rules on the job at line 54, or the 12m command_timeout exceeded by deep disk-usage scans \u2014 would survive the refspec fix alone."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "required_plan_changes": "None: this lane only fetches and never mirror-pushes, the ref is namespaced under refs/remotes/, and the workflow's concurrency group serializes this lane's own runs, so no consumer of refs/heads/* is affected.",
        "risk_id": "R-2",
        "severity": "LOW",
        "summary": "Writing refs/remotes/origin/main into the shared bare store is an additive ref write other readers of /var/aqua-saas did not previously observe."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:54"
        ],
        "required_plan_changes": "None: the verification story is stated explicitly in the validation plan \u2014 static gates land with the change and the instrumented next run is the runtime witness; the ::error lines exist to make that witness legible.",
        "risk_id": "R-3",
        "severity": "LOW",
        "summary": "None of the declared validation commands executes the workflow, so YAML runtime validity is proven only by the next scheduled or dispatched run."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "required_plan_changes": "None in this envelope: this cycle's allowed scope binds the edit to the single workflow file, and the sibling-lane sweep is recorded as a follow-up finding proposal in details.revision for operator routing through its own envelope.",
        "risk_id": "R-4",
        "severity": "LOW",
        "summary": "Sibling deploy lanes that resolve origin/main through an implicit refspec against the same bare object store carry the same latent failure pattern (CR-005)."
      }
    ],
    "rollback": "The change is a single-file edit with no infrastructure state mutation of its own \u2014 it only changes how refs are resolved before the existing bounded operations run. Rollback: git revert --no-edit of the single commit touching .github/workflows/deploy-capacity-maintenance.yml, restoring the exact prior script byte-for-byte. Revert only on evidence the new refspec fetch broke a previously-green path (e.g. a store hook rejecting refs/remotes/ writes); reverting also restores the currently-failing resolution behavior, so the revert decision needs the failing run's log, not just a red check.",
    "schema_version": 2,
    "summary": "The capacity-maintenance lane fails at head 99689e46bd86eb980ca2bad74df3c6b072eb4e90 inside its single SSH step (line 59), and the workflow file itself names the one unguarded, layout-dependent stage in that step's chain: the script documents /var/aqua-saas as the persistent bare object store, yet resolves main via 'git fetch --force --prune origin main' followed by 'git rev-parse origin/main' \u2014 a read whose success depends on remote-tracking refs a bare store does not guarantee, so under 'set -euo pipefail' the read aborts the step with an anonymous git error. The revision pins the fetch to write exactly the ref the script reads (+refs/heads/main:refs/remotes/origin/main), verifies that ref peels to a commit before exporting DEPLOY_SHA, and gives every remaining resolution stage a stage-named ::error (fetch / sha-resolve / helper-missing) so the next lane run converts inference into observation whichever assumption was wrong. Only .github/workflows/deploy-capacity-maintenance.yml changes; the IMAGE_PREFIX guard, bootstrap, checkout materialization, and operation dispatch stay byte-identical. The four canonical validation gates run statically, and the next scheduled or operator-dispatched run is the runtime witness.",
    "title": "Deploy Capacity Maintenance: make host-side main resolution an explicit fetch-to-read ref contract with stage-named failures",
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
    "validation_plan": "Declared executable gates, all four from the canonical suite: npx nx affected --target=test; npx nx affected --target=lint; npm run type-check; node tools/quality/quality.mjs format check-changed \u2014 the format gate is the one that parses the changed YAML. These prove the edit is statically sound. The runtime proof, which no sandboxed command can provide, is the next execution of the lane. Success criteria: exit 0 with the capacity report emitted; or exactly one stage-named ::error line (fetch / sha-resolve / helper-missing) identifying the true failing stage \u2014 the second outcome converts the following round's diagnosis from inference to observation and is treated as new evidence for the next round, not as a silent verdict on the refspec change."
  },
  "request_id": "AIR-aria-primary-planner-5abf63e0e69e",
  "role": "primary_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        ".github/workflows/deploy-capacity-maintenance.yml:59",
        ".github/workflows/deploy-capacity-maintenance.yml"
      ],
      "id": "key-change-0",
      "note": "Revised key_changes[0] (id ci-run-38409794036-key-change-001) now carries the root-cause diagnosis and the exact guarded edit fragments for the failing step at line 59 \u2014 an explicit-refspec fetch writing refs/remotes/origin/main, a peel-verified rev-parse before DEPLOY_SHA export, and a git cat-file existence check for scripts/deploy/deploy-paths.sh \u2014 touching only .github/workflows/deploy-capacity-maintenance.yml, the sole path the obligation lists. The diagnosis is anchored in the file's own text: the script documents /var/aqua-saas as the persistent bare object store, a refspec-less 'git fetch origin main' writes only FETCH_HEAD there, and 'git rev-parse origin/main' then aborts the step anonymously under 'set -euo pipefail'. Everything else in the script stays byte-identical.",
      "verdict": "satisfied"
    },
    {
      "evidence_refs": [
        ".github/workflows/deploy-capacity-maintenance.yml:59",
        ".github/workflows/deploy-capacity-maintenance.yml"
      ],
      "id": "plan_contract:plan_architectural_tier_missing",
      "note": "plan_content.architectural_tier = 2 is claimed on the body with justification in plan_content.architectural_approach: the fetch writes exactly the ref the script reads (+refs/heads/main:refs/remotes/origin/main), so correct resolution becomes the zero-effort default on any bare-store layout, with stage-named ::error detection as a secondary property of the same change. Every plan_content.validation_commands entry names one of the four canonical-suite commands declared in this request's plan contract; key_changes[] carries the {id, description, paths, imports} shape with imports: [] since no TypeScript/JavaScript source is touched.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
