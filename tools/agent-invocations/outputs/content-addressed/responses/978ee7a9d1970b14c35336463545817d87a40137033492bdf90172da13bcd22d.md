{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-38683514532",
  "claim_id": "claim_839b437d5d7c79f7",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:ad4d0c0796acf00f0143d3603cf4bc0d3faaf5d527964f0541920c86d20041e0",
    "agent_dispatch_model": "glm-5.3",
    "agent_subagent_type": "aria-challenger-planner",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-challenger-planner-1b6412a67a39\",\n  \"claim_id\": \"plan-cyc-20261015T025757Z-auto\",\n  \"agent_id\": \"aria-challenger-planner\",\n  \"role\": \"challenger_plan\",\n  \"status\": \"submitted\",\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/plan-cyc-20261015T025757Z-auto/round-2-challenger_plan-AIR-aria-challenger-planner-1b6412a67a39.md\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"key_changes[0] of this plan (id ci-run-38680893046-key-change-001) is exactly the obligation's change: it diagnoses the failing 'Deploy Capacity Maintenance' workflow on head 99689e46bd86eb980ca2bad74df3c6b072eb4e90 and lands the architectural fix, touching only .github/workflows/deploy-capacity-maintenance.yml \u2014 the single path listed in the obligation's paths.\",\n      \"evidence_refs\": [\n        \".github/workflows/deploy-capacity-maintenance.yml:59\",\n        \".github/workflows/deploy-capacity-maintenance.yml:54\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \".github/workflows/deploy-capacity-maintenance.yml:59\",\n    \".github/workflows/deploy-capacity-maintenance.yml:54\",\n    \".github/workflows/deploy-capacity-maintenance.yml\"\n  ],\n  \"plan_content\": {\n    \"schema_version\": 2,\n    \"title\": \"Deploy Capacity Maintenance: convert the single SSH step's unverified contract chain into named, fail-fast boundary checks (diagnose + architectural fix for the red capacity lane)\",\n    \"summary\": \"The failing check is the workflow's single job and single SSH step, whose entire remote operation is one 'set -euo pipefail' chain with no boundary verification; the newest change to this file (commit 8bcacb2519dc, INFRA-CRITICAL-085) rewired IMAGE_PREFIX derivation (from github.repository) and DEPLOY_SHA resolution (from the bare store's origin/main) and left both contracts unverified at run time. This plan rewrites the step's pre-flight into named, fail-fast boundary checks \u2014 forwarded env vars, bare-store target-ref resolution covering both bare-clone and mirror layouts, the deploy-paths.sh bootstrap from TARGET_SHA, the materialize_deploy_checkout/DEPLOY_CHECKOUT_DIR contract, and capacity-script presence \u2014 each emitting a capacity-maintenance:<class> error before any maintenance action, plus a per-run diagnosis trail of the resolved values. The change touches only .github/workflows/deploy-capacity-maintenance.yml, preserves the INFRA-CRITICAL-085 property that no dispatch input names a release, image, registry or repository, and claims architectural tier 3 (detectable).\",\n    \"affected_surfaces\": [\n      {\n        \"paths\": [\n          \".github/workflows/deploy-capacity-maintenance.yml\"\n        ]\n      }\n    ],\n    \"key_changes\": [\n      {\n        \"id\": \"ci-run-38680893046-key-change-001\",\n        \"description\": \"Diagnose and fix the failing Deploy Capacity Maintenance check. Root cause as read from the only admissible evidence: the workflow's entire remote operation runs as one 'set -euo pipefail' script behind the single SSH step with zero contract verification, so whichever link breaks \u2014 forwarded env vars, bare-store origin/main resolution, the 'git show <sha>:scripts/deploy/deploy-paths.sh' bootstrap, materialize_deploy_checkout/DEPLOY_CHECKOUT_DIR, or the capacity-script path \u2014 the run dies as an opaque non-zero exit; the newest commit to this file (8bcacb2519dc) rewired IMAGE_PREFIX (now derived from github.repository) and DEPLOY_SHA (now resolved from the remote's current main) and added no run-time verification for either. Fix, all inside .github/workflows/deploy-capacity-maintenance.yml: (a) assert OPERATION, FULL_DEPLOY, DEPLOY_SERVICES, IMAGE_REPOSITORY are non-empty immediately after 'set -euo pipefail', failing with a named capacity-maintenance:env error; (b) resolve TARGET_SHA with 'git rev-parse --verify' trying refs/remotes/origin/mai...",
    "diagnosis_basis": "Evidence verification note: the three untrusted excerpts (lines 19-99, 14-94, 1-116) are mutually consistent across their overlapping ranges, which is the corroboration relied on; sha256 hashes could not be recomputed in this environment. The coverage-manifest evidence ref is malformed (skipped by the payload as malformed_ref) and is deliberately not cited anywhere in this envelope \u2014 citing it would repeat the historical agent_evidence_ref_malformed rejection recorded for this agent.",
    "independence_method": "Challenger traversal ran consumer-to-code: deploy-lane capacity gate, then the GHCR producer/consumer identity contract, then droplet state namespaces, then the workflow step's internal script chain last. The primary plan was neither read nor available; any convergence with it is independent arrival.",
    "runtime_attempt_ledger_hash": "sha256:9a54ce7f96d401d801357514a3dabbec46fdf9daaff17a82595af94656716dbe"
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
    "architectural_approach": "Tier 3 (make it detectable). Tier 1 is unreachable from the writable surface: the failing contracts bind remote runtime state \u2014 the droplet's git store layout, the login shell, the GHCR namespace \u2014 which no type system available to a GitHub Actions workflow can structurally constrain. Tier 2 is already spent where it applies: schedule-safe defaults (inputs.* || fallback for OPERATION/FULL_DEPLOY/DEPLOY_SERVICES) and the dispatcher-scope removal (INFRA-CRITICAL-085) already make the correct operation and scope the zero-effort default. What remains is the failure path: each contract boundary becomes an explicit, named check executed before any maintenance action, converting opaque mid-chain 'set -e' aborts into capacity-maintenance:<class> errors and logging the resolved values. For CI infrastructure, run time of the check itself is the build/test-time boundary this tier names; the acceptance signal is that any future red run fails with a named class rather than an opaque abort.",
    "architectural_tier": 3,
    "context": "What must be done and why, as a cause/effect chain: this workflow is the production droplet's only scheduled sweeper (cron '0 */6 * * *') for the untagged image generations every deploy leaves behind (~1.85GB x 13 per deploy, per the workflow's own header); when the lane stays red, nothing sweeps, the droplet climbs past the capacity threshold, and the next production deploy is blocked at capacity preflight \u2014 the exact #695 / 28332208818 / 28330781676 class this lane was created to prevent. The red check on head 99689e4 points at the single job (.github/workflows/deploy-capacity-maintenance.yml:54) and its single step (:59), which wraps the whole remote operation in one 'set -euo pipefail' SSH script with no boundary verification: a broken link surfaces as an opaque non-zero exit buried in the log, and a subtly wrong link (for example an IMAGE_PREFIX that passes the regex but no longer matches the producers' namespace) can make the GC a silent no-op while the run stays green. The newest change to this file (8bcacb2519dc, INFRA-CRITICAL-085) rewired two of those links \u2014 IMAGE_PREFIX from github.repository and DEPLOY_SHA from the bare store's origin/main \u2014 without adding run-time verification. What breaks if skipped: capacity debt re-accumulates until deploys block, and the red lane gives no signal distinguishing an infra-environment fault from a contract fault in the changed code. Downstream surfaces affected: the deploy capacity-preflight gate (consumer of droplet headroom), the GHCR namespace shared with the image producers, and the /var/lib/aqua deploy-checkout namespace shared with the deploy control plane. Evidence proving the result: each boundary emits a named capacity-maintenance:<class> error and the resolved values are logged per run, so the failing contract is identifiable by name from the next run's log; repo-side, the canonical suite proves no collateral breakage.",
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
        "description": "Diagnose and fix the failing Deploy Capacity Maintenance check. Root cause as read from the only admissible evidence: the workflow's entire remote operation runs as one 'set -euo pipefail' script behind the single SSH step with zero contract verification, so whichever link breaks \u2014 forwarded env vars, bare-store origin/main resolution, the 'git show <sha>:scripts/deploy/deploy-paths.sh' bootstrap, materialize_deploy_checkout/DEPLOY_CHECKOUT_DIR, or the capacity-script path \u2014 the run dies as an opaque non-zero exit; the newest commit to this file (8bcacb2519dc) rewired IMAGE_PREFIX (now derived from github.repository) and DEPLOY_SHA (now resolved from the remote's current main) and added no run-time verification for either. Fix, all inside .github/workflows/deploy-capacity-maintenance.yml: (a) assert OPERATION, FULL_DEPLOY, DEPLOY_SERVICES, IMAGE_REPOSITORY are non-empty immediately after 'set -euo pipefail', failing with a named capacity-maintenance:env error; (b) resolve TARGET_SHA with 'git rev-parse --verify' trying refs/remotes/origin/main then refs/heads/main (covers both bare-clone refspecs, which update refs/remotes/origin/main, and mirror-layout stores, which update refs/heads/main directly), failing with a named capacity-maintenance:target-ref error; (c) guard the helper bootstrap with 'git cat-file -e <TARGET_SHA>:scripts/deploy/deploy-paths.sh' before the redirect, failing with capacity-maintenance:bootstrap-helper; (d) after sourcing, assert materialize_deploy_checkout is a declared function ('declare -F'), and after calling it assert DEPLOY_CHECKOUT_DIR is non-empty and an existing directory before 'cd', failing with capacity-maintenance:checkout \u2014 this also eliminates the silent cd-to-HOME wrong-directory class when the variable is unset under 'set -u'; (e) assert scripts/deploy/droplet-capacity.sh exists in the checkout before the operation case, failing with capacity-maintenance:capacity-script. Every check prints its error to stderr and exits non-zero before any maintenance or GC action executes. The diff adds no new dispatch input and changes no operation mapping, GC scope, schedule, secret, or concurrency declaration.",
        "id": "ci-run-38680893046-key-change-001",
        "imports": [],
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Add a per-run diagnosis trail to the same step: echo 'capacity-maintenance:'-prefixed lines for the resolved IMAGE_PREFIX, TARGET_SHA, DEPLOY_CHECKOUT_DIR and OPERATION at each boundary, so the next red run \u2014 or a green run whose GC silently matches nothing because the derived prefix drifted from the producers' GHCR namespace \u2014 pinpoints the failing contract from the Actions log alone, without droplet SSH access.",
        "id": "ci-run-38680893046-key-change-002",
        "imports": [],
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      "Verify the edit with the declared canonical suite (npx nx affected --target=test, npx nx affected --target=lint, npm run type-check, node tools/quality/quality.mjs format check-changed); operational confirmation after merge is a read-only workflow_dispatch with operation=report completing green with the capacity-maintenance: trail printed."
    ],
    "plan_steps_detailed": [
      "Step 1 (key_changes[0], the obligation's change): edit only .github/workflows/deploy-capacity-maintenance.yml. In the step's remote script, after 'set -euo pipefail': assert the four forwarded env vars are non-empty; derive and regex-validate IMAGE_PREFIX as today; in /var/aqua-saas, keep 'git fetch --force --prune origin main', then resolve TARGET_SHA via 'git rev-parse --verify' over refs/remotes/origin/main with fallback to refs/heads/main; guard 'git cat-file -e \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\"' before the bootstrap redirect; after sourcing, assert 'declare -F materialize_deploy_checkout'; after calling it, assert DEPLOY_CHECKOUT_DIR is non-empty and an existing directory before 'cd'; assert scripts/deploy/droplet-capacity.sh exists before the operation case. Each failed assertion prints a capacity-maintenance:<class> error to stderr and exits non-zero before any GC or gate action. Why: every currently-implicit contract becomes a named pre-condition, so the red check self-diagnoses and the silent no-op class (wrong-but-valid prefix, empty checkout var) becomes impossible to miss. Skipped: the lane stays opaque and the deploy-blocking debt class returns.",
      "Step 2 (key_changes[1]): add 'capacity-maintenance:' echo lines for resolved IMAGE_PREFIX, TARGET_SHA, DEPLOY_CHECKOUT_DIR, OPERATION at each boundary. Why: the Actions log becomes sufficient to adjudicate any future failure without droplet access \u2014 the evidence surface moves into the artifact operators already read.",
      "Step 3 (key_changes[2]): run the declared canonical suite; the format gate covers the changed YAML (the repository's enforced format gate), and affected lint/test/type-check prove no project surface moved. Operational confirmation after merge: a read-only workflow_dispatch with operation=report completes green and prints the trail; the next scheduled 6-hourly safe-image-gc run is the steady-state proof."
    ],
    "recursive_impact": "Traversal consumer-to-code, per challenger discipline. (1) Consumer: the production deploy lane's capacity-preflight gate reads droplet disk headroom; this workflow is the only scheduled sweeper, so a red or no-op lane propagates as blocked future deploys, not as repo-code breakage \u2014 the #695 / 28332208818 / 28330781676 class named in the workflow's own header. (2) Contract: the GHCR namespace 'ghcr.io/${IMAGE_REPOSITORY,,}' is the shared identity with the image producers (deploy-digitalocean 'prepare' derives the same value, per the workflow's env comment); drift between producer prefix and GC prefix is invisible in a green run and is exactly what the diagnosis trail exposes. (3) State: /var/aqua-saas (bare object store) and /var/lib/aqua/deploy (checkout namespace) are shared mutable state with the rest of the deploy control plane; a mis-resolved TARGET_SHA would run maintenance from a stale tree, which the named target-ref and checkout checks prevent. (4) Repo closure: no nx project, event contract, or DB entity consumes this YAML \u2014 the in-repo impact closure is the workflow file itself, matching affected_surfaces with no coverage waivers required.",
    "risks": [
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "risk_id": "CH-R-1",
        "severity": "MEDIUM",
        "summary": "Diagnosis confidence: the CI run log is not admissible repo evidence (the round-1 coverage-manifest ref is malformed and was skipped by the evidence payload), so the failing link is inferred from the workflow's own text and from the contract rewiring in the newest commit 8bcacb2519dc; if the true fault is environmental (secrets, environment protection, runner), the boundary checks localize it on the next run, but the first green may require one further targeted edit in the same file."
      },
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:54"
        ],
        "risk_id": "CH-R-2",
        "severity": "MEDIUM",
        "summary": "If /var/aqua-saas is a mirror-layout store, 'git rev-parse origin/main' fails after the fetch because mirror refspecs update refs/heads/main directly; the candidate-ref fallback in key_changes[0] covers both layouts, and the named capacity-maintenance:target-ref error isolates the case if a third layout exists."
      },
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "risk_id": "CH-R-3",
        "severity": "LOW",
        "summary": "Silent no-op class: an IMAGE_PREFIX that passes the regex but drifts from the producers' GHCR namespace would let GC match nothing while the run stays green, re-accumulating capacity debt until deploys block; the per-run echo of the resolved prefix makes the mismatch visible in the Actions log, and the producer identity (deploy-digitalocean prepare derives the same ghcr.io value) is the cross-check."
      },
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "risk_id": "CH-R-4",
        "severity": "LOW",
        "summary": "Shell dependency: the remote script already requires bash features (${IMAGE_REPOSITORY,,} lowercasing, [[ =~ ]] regex), so the added checks introduce no new shell requirement; appleboy/ssh-action v1.0.3 executes via the droplet user's login shell, unchanged by this plan."
      },
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:54"
        ],
        "risk_id": "CH-R-5",
        "severity": "LOW",
        "summary": "Timeout budget: the added checks are O(1) local git/filesystem operations and do not press the 12m command_timeout or the 15m job timeout that bound the capacity work."
      }
    ],
    "rollback": "Single-file revert: 'git revert' of the one commit touching .github/workflows/deploy-capacity-maintenance.yml restores the prior script verbatim. The change adds guards, named errors, and echo lines only \u2014 it alters no operation mapping, GC scope, schedule, secret, or concurrency declaration \u2014 so reversion cannot strand behavior. Droplet-side /var/lib/aqua/deploy checkouts are rebuilt per run from TARGET_SHA (the workflow materializes the checkout from the exact target commit), so no host-side cleanup belongs to rollback.",
    "schema_version": 2,
    "summary": "The failing check is the workflow's single job and single SSH step, whose entire remote operation is one 'set -euo pipefail' chain with no boundary verification; the newest change to this file (commit 8bcacb2519dc, INFRA-CRITICAL-085) rewired IMAGE_PREFIX derivation (from github.repository) and DEPLOY_SHA resolution (from the bare store's origin/main) and left both contracts unverified at run time. This plan rewrites the step's pre-flight into named, fail-fast boundary checks \u2014 forwarded env vars, bare-store target-ref resolution covering both bare-clone and mirror layouts, the deploy-paths.sh bootstrap from TARGET_SHA, the materialize_deploy_checkout/DEPLOY_CHECKOUT_DIR contract, and capacity-script presence \u2014 each emitting a capacity-maintenance:<class> error before any maintenance action, plus a per-run diagnosis trail of the resolved values. The change touches only .github/workflows/deploy-capacity-maintenance.yml, preserves the INFRA-CRITICAL-085 property that no dispatch input names a release, image, registry or repository, and claims architectural tier 3 (detectable).",
    "title": "Deploy Capacity Maintenance: convert the single SSH step's unverified contract chain into named, fail-fast boundary checks (diagnose + architectural fix for the red capacity lane)",
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
    "validation_plan": "Declared validation_commands are the canonical suite only: 'npx nx affected --target=test', 'npx nx affected --target=lint', 'npm run type-check', 'node tools/quality/quality.mjs format check-changed' (the enforced format gate covers the changed YAML). No project source consumes this file, so affected targets should pass unchanged \u2014 a failure there indicates collateral damage, not expected signal. Operational acceptance, run by the operator outside the implementer sandbox: (1) a read-only workflow_dispatch with operation=report must complete green and print the capacity-maintenance: trail with resolved IMAGE_PREFIX/TARGET_SHA/DEPLOY_CHECKOUT_DIR; (2) any subsequent red run must fail with a named capacity-maintenance:<class> error rather than an opaque mid-chain abort \u2014 that named-error property is the tier-3 acceptance criterion; (3) the next scheduled run must keep the droplet under the capacity threshold between deploys."
  },
  "request_id": "AIR-aria-challenger-planner-1b6412a67a39",
  "role": "challenger_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        ".github/workflows/deploy-capacity-maintenance.yml:59",
        ".github/workflows/deploy-capacity-maintenance.yml:54"
      ],
      "id": "key-change-0",
      "note": "key_changes[0] of this plan (id ci-run-38680893046-key-change-001) is exactly the obligation's change: it diagnoses the failing 'Deploy Capacity Maintenance' workflow on head 99689e46bd86eb980ca2bad74df3c6b072eb4e90 and lands the architectural fix, touching only .github/workflows/deploy-capacity-maintenance.yml \u2014 the single path listed in the obligation's paths.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
