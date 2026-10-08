{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-37785407758",
  "claim_id": "claim_75a8e057cb554b76",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:3ffe75613eccae71e113d8a6eb7fc7127fdb782c07333c3817ee9e071b5ca4b3",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-primary-planner",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-primary-planner-bdcd6417f6a3\",\n  \"claim_id\": \"AIR-aria-primary-planner-bdcd6417f6a3\",\n  \"agent_id\": \"aria-primary-planner\",\n  \"role\": \"primary_plan\",\n  \"status\": \"submitted\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"The revision keeps the obligation's mandate and its single path, and replaces the restatement with concrete edits. Mandate part one, diagnose the root cause: the lone step anchored at .github/workflows/deploy-capacity-maintenance.yml:59 carries the lane's entire contract (GHCR prefix derivation plus regex refusal, remote-main SHA resolution, deploy-paths.sh bootstrap, materialize_deploy_checkout, and the case dispatch into scripts/deploy/droplet-capacity.sh) under one command_timeout: 12m inside the job's timeout-minutes: 15 at .github/workflows/deploy-capacity-maintenance.yml:54, so a bootstrap fault, a budget exhaustion and a capacity-alarm gate exit all render as the same single red step with no class attached. Mandate part two, land an architectural fix: four key changes split that step into two named, separately-budgeted SSH stages with an atomic run-identity-guarded handoff, add fail-closed runner-side gate steps that read steps.<id>.outcome and emit titled annotations, give the remote maintenance stage a documented exit-code vocabulary (2 refusal, 20 capacity verdict nonzero, 21 capacity script not executable, 22 handoff mismatch), and document the three classes plus the budget arithmetic in the file's comments. Every edit lands in .github/workflows/deploy-capacity-maintenance.yml and in no other file; permissions contents: read, the concurrency group, environment: production, the cron, the three inputs, the INFRA-CRITICAL-085 input posture and the pinned appleboy/ssh-action SHA are reused unchanged. One bound is stated plainly rather than papered over: the failing run's own log signature is not in this request's admissible evidence (the only non-path ref offered, coverage-manifest:plan-cyc-20261008T120143Z-auto-r1.json, was delivered skipped as malformed_ref), so the root cause this plan claims and fixes is the one the file's own structure proves \u2014 the lane cannot report which class failed \u2014 and that bound is registered as risk R-P-01 rather than hidden.\",\n      \"evidence_refs\": [\n        \".github/workflows/deploy-capacity-maintenance.yml:59\",\n        \".github/workflows/deploy-capacity-maintenance.yml:54\",\n        \".github/workflows/deploy-capacity-maintenance.yml\"\n      ]\n    },\n    {\n      \"id\": \"plan_contract:plan_architectural_tier_missing\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"plan_content.architectural_tier is now claimed as 3 (make the wrong behaviour detectable at build or test time), and the refused entry the gate named (plan_content.architectural_tier is required, one of 1, 2, 3, 4) is answered with a value from that set plus its justification in plan_content.architectural_approach. Tier 3 is the honest ceiling for this request, not a fallback: tier 1 would require structurally preventing the wrong behaviour, but the wrong behaviours are host-side (droplet disk exhaustion, unreachable host, control-plane bootstrap faults) and a workflow file cannot make them impossible; tier 2 would make correct host state the zero-effort default, which lives in scripts/deploy/ and on the droplet, and this request's allowed_scope names only .github/workflows/deploy-capacity-maintenance.yml. What the file can do structurally is guarantee every failure class arrives at CI with its own step name, its own budget and its own annotation \u2014 detection, which is tier 3. One element inside the plan is stronger than its governing tier (the RUN_IDENTITY guard makes reuse of a stale Stage 1 handoff structurally impossible rather than merely detectable), and the tier is still claimed as 3 because the defect the plan actually removes is the lane's inability to name its failure class. ...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 108645,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 108645,
      "cache_read_input_tokens": 0,
      "inference_geo": "not_available",
      "input_tokens": 2,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 108645,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 108645,
          "cache_read_input_tokens": 0,
          "input_tokens": 2,
          "output_tokens": 36775,
          "type": "message"
        }
      ],
      "output_tokens": 36775,
      "output_tokens_details": {
        "thinking_tokens": 21054
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "evidence_verification": "Line anchors were verified against the delivered excerpts and their content hashes; the file was not re-read because the excerpts were sufficient. Line 54 is the capacity-maintenance job key, whose runs-on, timeout-minutes: 15 and environment: production follow at 55-57. Line 59 is the lone step name, 'Run capacity operation through production deploy control plane', with the pinned appleboy/ssh-action at 60. The one ref that was insufficient is coverage-manifest:plan-cyc-20261008T120143Z-auto-r1.json, delivered with skipped=\"malformed_ref\" and no content; it is not cited in any evidence_refs list in this envelope, and the empty-closure claim that would otherwise rest on it is argued structurally instead (not an nx project, no libs/event-contracts/** interface, no *.entity.ts) and is consistent with this request carrying no coverage_gap must_satisfy item.",
    "failing_run_provenance": "Workflow run 37782945896, Deploy Capacity Maintenance, head 73d8b2133f10b4af7473e573864c2ea3ddef6efc. Carried as narrative provenance only: no run-id-shaped reference appears in any evidence_refs list in this envelope, because such a reference does not resolve to a repository file and is refused as agent_evidence_ref_malformed.",
    "identity_note": "The delivered request names request_id AIR-aria-primary-planner-bdcd6417f6a3, role primary_plan, convergence plan-cyc-20261008T120143Z-auto and round 2, but carries no distinct claim_id. The required claim_id field therefore mirrors request_id and the claim held by the submitting executor is authoritative; this substitution is disclosed rather than presented as a value read from the request.",
    "output_note": "This invocation route provided no write tool (no Write, Edit or Bash in the available surface), so the markdown document could not be rendered at expected_output_path and output_path is omitted from this envelope rather than claimed. The complete plan \u2014 context, recursive impact, architectural approach, numbered steps, validation plan, rollback and risk register \u2014 rides in plan_content as the narrative keys the kernel passes through, per this route's runtime note that the response is the single aria/agent-response/v1 envelope.",
    "revision": {
      "addresses_review_risk_ids": [
        "CR-001",
        "CR-002",
        "CR-003",
        "CR-004"
      ],
      "addresses_review_risk_ids_directed_at_primary": [
        "CR-001",
        "CR-002"
      ],
      "resolution_notes": {
        "CR-001": "Resolved. plan_content.architectural_tier is now 3, with plan_content.architectural_approach rejecting tiers 1 and 2 on stated grounds (the wrong behaviours are host-side and the files that would make correct host state automatic are not in allowed_scope) and claiming detection as what this one file can structurally guarantee. The refused entry the gate named is answered with a value from the 1|2|3|4 set, so plan_architectural_tier_missing cannot recur at submit or at the plan_contract_complete gate.",
        "CR-002": "Resolved. The single restating key change is replaced by four key changes (kc-1..kc-4), each naming concrete edits to .github/workflows/deploy-capacity-maintenance.yml: the two-stage split with per-stage budgets and the run-identity-stamped atomic handoff, the fail-closed runner-side gate steps, the remote exit-code vocabulary, and the comment block carrying the three classes plus the budget arithmetic. Six numbered steps in plan_steps_detailed bind each edit to an evidence ref and a must_satisfy id, and a five-entry risk register is present. The evidence-boundary risk the challenger disclosed as R-CH-01 is carried as R-P-01 and is also stated in the summary, the context and the key-change-0 verdict note rather than left implicit.",
        "CR-003": "Raised against the challenger plan; resolved in this body because this revision adopts the shared structural approach and must not inherit the defect. The relay mechanism is named and requires no log post-processing by a uses: step: each SSH stage carries continue-on-error: true and an id, and a following plain run: step reads steps.<id>.outcome, emits a titled annotation and exits 1 on anything other than an exact success match. Because the gate step itself fails, the next stage is skipped by default step semantics, so no reliance is placed on unverified appleboy/ssh-action internals or on the action exposing an exit-code output.",
        "CR-004": "Raised against the challenger plan; resolved in this body for the same reason. Stage budgets are trimmed to 2m plus 10m, which holds today's 12m total remote budget exactly while leaving roughly 3m of the unchanged timeout-minutes: 15 for runner spin-up, two action startups, two SSH handshakes and the two gate steps, so a per-stage command_timeout fires before the job cap and the cap stays a backstop. kc-4 and Step 6 place that overhead allowance in the same comment that carries the arithmetic, as the cross-review recommended, and R-P-03 records that raising timeout-minetes instead would make the job cap the active bound again."
      }
    },
    "runtime_attempt_ledger_hash": "sha256:08de817405a38ad509a3fe82011762cbb8a4ed03f7b9bdff6b85335e831c7395"
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
    "architectural_approach": "Claimed tier: 3, make it detectable. The hierarchy is applied top-down and the two higher tiers are rejected for stated reasons, not skipped. Tier 1, make it impossible, would require the type system, compiler or runtime to structurally prevent the wrong behaviour; the wrong behaviours here are a droplet over its disk threshold, an unreachable host and a control-plane bootstrap fault, none of which a workflow file can render impossible. Tier 2, make the correct behaviour the zero-effort default, would mean the droplet keeps itself under threshold without this lane at all; that correctness lives in scripts/deploy/droplet-capacity.sh and in host provisioning, and this request's allowed_scope names exactly one path, .github/workflows/deploy-capacity-maintenance.yml, so a plan reaching into those files would be a scope violation rather than a better plan. What the file can do structurally is make the wrong behaviour impossible to miss at CI time: every failure class gets its own step name, its own timeout budget, and its own runner-side annotation, and the class is therefore caught and attributed at build time rather than inferred later from a buried log. That is detection, which is tier 3, and the claim is made at the tier the change actually reaches. Two notes keep the claim honest in both directions. First, one element inside the plan is structurally preventive rather than merely detective: the RUN_IDENTITY stamp in the handoff env file means Stage 2 cannot consume a stale Stage 1 state at all, instead of consuming it and reporting afterwards \u2014 the plan still claims 3 overall because the defect being removed is the missing class signal. Second, the design deliberately avoids the one thing that would be a regression dressed as an improvement: nothing here softens a failure. The capacity verdict still fails the job, the gate steps' default branch is failure with an exact-match success branch as the only pass, and the remote exit-code capture re-raises every nonzero status. A relay that could swallow a remote failure would convert the test suite and the gate from oracle into theatre, which is why the fail-closed shape is specified as a hard property of kc-2 and kc-3 rather than an aspiration.",
    "architectural_tier": 3,
    "context": "What the lane does, and why its red runs teach nobody anything. Every six hours (cron 0 */6 * * *) or on dispatch, one step \u2014 the step anchored at .github/workflows/deploy-capacity-maintenance.yml:59 \u2014 opens a single SSH session to the production droplet and runs the lane's entire contract inside it: derive IMAGE_PREFIX from github.repository and refuse a malformed prefix with exit 2, cd into the bare object store at /var/aqua-saas, git fetch --force --prune origin main, resolve TARGET_SHA from origin/main, install -d /var/lib/aqua/deploy, bootstrap scripts/deploy/deploy-paths.sh out of that exact commit, source it, materialize_deploy_checkout, cd into the immutable checkout, and dispatch on OPERATION into scripts/deploy/droplet-capacity.sh (report, or the GC-plus-verdict gate for safe-image-gc and gate). All of it runs under one command_timeout: 12m nested inside the capacity-maintenance job's timeout-minutes: 15 at line 54. Now work backward from the consumer, which is the on-call engineer looking at a red run: three genuinely different events \u2014 the control plane failed to bootstrap, the shared 12m budget ran out, or the droplet is still over threshold after a bounded GC pass and the gate correctly says so \u2014 all arrive as the same red step with the same name, 'Run capacity operation through production deploy control plane'. The first two mean the maintenance did not happen and the lane needs repair; the third means the maintenance did happen and the droplet needs capacity. They demand opposite responses and the run page cannot tell them apart. That is the root cause this plan removes, and it is the root cause the admissible evidence actually proves: the lane's own structure is the defect. If this is skipped, the next red run again names no class, the capacity-preflight gate keeps blocking deploys for reasons nobody can attribute, and the one-fix-per-recurrence pattern visible in this file's own header (the #695 / 28332208818 / 28330781676 capacity failures) continues. One boundary is stated rather than smoothed over: the failing run's log signature is not in this request's admissible evidence, so this plan does not claim to know which of the three classes that particular run hit \u2014 it claims, and fixes, the reason that question is unanswerable.",
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
        "description": "Split the lone step at .github/workflows/deploy-capacity-maintenance.yml:59 into two named, separately-budgeted SSH stages with an atomic, run-identity-stamped handoff. Stage 1, named 'Resolve deploy target and bootstrap immutable checkout' with id: bootstrap and command_timeout: 2m, keeps the existing remote body verbatim up to and including materialize_deploy_checkout \"${TARGET_SHA}\" \u2014 IMAGE_PREFIX=\"ghcr.io/${IMAGE_REPOSITORY,,}\" with its regex check and exit 2 refusal, cd /var/aqua-saas, git fetch --force --prune origin main, TARGET_SHA=\"$(git rev-parse origin/main)\", install -d /var/lib/aqua/deploy, git show \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\" into /var/lib/aqua/deploy/deploy-paths.sh, source, materialize_deploy_checkout \u2014 then writes DEPLOY_SHA, DEPLOY_CHECKOUT_DIR, IMAGE_PREFIX and RUN_IDENTITY to /var/lib/aqua/deploy/capacity-maintenance.env by writing a sibling path and mv-ing it into place, so the file is never observed half-written. Stage 2, named 'Run capacity maintenance (${{ inputs.operation || ''safe-image-gc'' }})' with id: maintenance and command_timeout: 10m, sources that env file, exports IMAGE_PREFIX, refuses with exit 22 unless RUN_IDENTITY equals this run's value, cds to \"${DEPLOY_CHECKOUT_DIR}\" and runs the existing case \"${OPERATION}\" dispatch unchanged (report arm with CAPACITY_DISK_USAGE_MODE=deep; safe-image-gc | gate arm with CAPACITY_GC_MODE=auto CAPACITY_DISK_USAGE_MODE=deep; unsupported-operation arm with exit 2). Both stages keep set -euo pipefail, the pinned appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2, the same host/username/key secrets, and receive only the env each needs: a new RUN_IDENTITY: ${{ github.run_id }}-${{ github.run_attempt }} entry in the job env, envs: IMAGE_REPOSITORY,RUN_IDENTITY on Stage 1 and envs: OPERATION,FULL_DEPLOY,DEPLOY_SERVICES,RUN_IDENTITY on Stage 2.",
        "id": "kc-1",
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Add one fail-closed runner-side gate step immediately after each SSH stage, using a mechanism that requires no log post-processing. Each SSH stage carries continue-on-error: true and an id (bootstrap, maintenance); the gate step that follows it is a plain run: step with no if: condition, so default step semantics run it whenever the job has not already failed. The gate reads steps.<id>.outcome \u2014 the pre-continue-on-error result \u2014 and passes only when it is exactly the string success; on every other value it emits echo \"::error title=Capacity maintenance: <stage name>::<class sentence naming the stage, its budget, and where to read the remote log>\" and then exit 1. Because the gate step itself genuinely fails, the stage that follows it is skipped by default semantics, so a failed Stage 1 can never let Stage 2 run against an unbuilt checkout. The default branch of each gate is failure and the only passing branch is an exact success match: no path in this change can mask a nonzero remote exit, and the gates are the reason continue-on-error: true is safe to set at all.",
        "id": "kc-2",
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Give Stage 2's remote script a documented exit-code vocabulary so the capacity-alarm class is labelled without softening it. Wrap only the single scripts/deploy/droplet-capacity.sh invocation with set +e, capture CAPACITY_STATUS=$?, restore set -e on the next line, then classify and re-raise: status 0 exits 0; status 126 or 127, or a failed test -f scripts/deploy/droplet-capacity.sh pre-check, emits ::error:: and exits 21 (the capacity script could not be executed); any other nonzero status emits ::error:: naming OPERATION and the captured status and exits 20 (the capacity script ran and reported a nonzero verdict \u2014 the capacity-alarm channel). The pre-existing refusals keep exit 2 (GHCR prefix malformed, unsupported operation) and the handoff guard from kc-1 uses exit 22. Every nonzero capacity status still produces a nonzero stage exit and therefore a failing gate step and a failing job: the capture relabels the failure, it never absorbs it, and no arm of the case dispatch, no threshold and no GC bound is changed.",
        "id": "kc-3",
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Record the diagnosis in the file's own comments so the next red run is readable from the run page alone, and leave every surrounding contract untouched. Add a comment block above the job's steps stating the three failure classes (control-plane and bootstrap fault; per-stage budget exhaustion; capacity operation outcome, split by exit code into verdict-nonzero and script-not-executable), which step name identifies each, and the exit-code vocabulary from kc-3. Add the budget arithmetic in the same comment that carries the timeouts: Stage 1 command_timeout: 2m plus Stage 2 command_timeout: 10m equals the 12m total remote budget the single step used today, leaving roughly 3m of the unchanged timeout-minutes: 15 for runner spin-up, two appleboy/ssh-action startups, two SSH handshakes and the two gate steps, so a per-stage timeout always fires before the job cap and the job cap stays a backstop rather than the active bound. Leave permissions contents: read, the concurrency group deploy-capacity-maintenance-production with cancel-in-progress: false, environment: production, the 0 */6 * * * cron, the three workflow_dispatch inputs with their defaults, the INFRA-CRITICAL-085 posture that no input names a release, image, registry or repository, and the pinned action SHA exactly as they are.",
        "id": "kc-4",
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      }
    ],
    "plan_steps_detailed": [
      "Step 1 \u2014 Stage 1 of the split, in .github/workflows/deploy-capacity-maintenance.yml. Replace the single step with 'Resolve deploy target and bootstrap immutable checkout' (id: bootstrap, continue-on-error: true, command_timeout: 2m), reusing the pinned appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2 and the same host/username/key secrets. Its remote script keeps set -euo pipefail and the existing body verbatim through materialize_deploy_checkout \"${TARGET_SHA}\": the IMAGE_PREFIX derivation with its regex check and exit 2 refusal, cd /var/aqua-saas, git fetch --force --prune origin main, TARGET_SHA=\"$(git rev-parse origin/main)\", install -d /var/lib/aqua/deploy, git show of deploy-paths.sh, source, materialize_deploy_checkout. It then writes DEPLOY_SHA, DEPLOY_CHECKOUT_DIR, IMAGE_PREFIX and RUN_IDENTITY to a sibling of /var/lib/aqua/deploy/capacity-maintenance.env and mv-s it into place, so no reader ever sees a partial file. Add RUN_IDENTITY: ${{ github.run_id }}-${{ github.run_attempt }} to the job env and set envs: IMAGE_REPOSITORY,RUN_IDENTITY on this stage. (evidence: .github/workflows/deploy-capacity-maintenance.yml:59, .github/workflows/deploy-capacity-maintenance.yml; satisfies: key-change-0)",
      "Step 2 \u2014 Stage 1's gate step, same file, immediately after Stage 1. A run: step named 'Check bootstrap stage outcome', with no if: condition so default semantics always run it while the job is healthy. It passes only when steps.bootstrap.outcome is exactly success; on any other value it runs echo \"::error title=Capacity maintenance: bootstrap stage::Resolving the deploy target or bootstrapping the immutable checkout failed or exceeded its 2m budget; read the bootstrap stage log\" and then exit 1. Because this step genuinely fails, Stage 2 and its own gate are skipped by default semantics, which is what prevents a failed bootstrap from running maintenance against an unbuilt checkout. This step is the named mechanism that makes continue-on-error: true on Stage 1 safe, and it requires no post-processing of the action's log stream. (evidence: .github/workflows/deploy-capacity-maintenance.yml:59; satisfies: key-change-0, plan_contract:plan_architectural_tier_missing)",
      "Step 3 \u2014 Stage 2 of the split, same file. Add 'Run capacity maintenance (${{ inputs.operation || ''safe-image-gc'' }})' (id: maintenance, continue-on-error: true, command_timeout: 10m, envs: OPERATION,FULL_DEPLOY,DEPLOY_SERVICES,RUN_IDENTITY). Its remote script sets set -euo pipefail, requires /var/lib/aqua/deploy/capacity-maintenance.env to exist, sources it, exports IMAGE_PREFIX, compares the sourced RUN_IDENTITY against this run's and on mismatch emits ::error:: and exits 22, then cds to \"${DEPLOY_CHECKOUT_DIR}\" and runs the existing case \"${OPERATION}\" dispatch with all three arms unchanged: report with CAPACITY_DISK_USAGE_MODE=deep, safe-image-gc | gate with CAPACITY_GC_MODE=auto CAPACITY_DISK_USAGE_MODE=deep, and the unsupported-operation arm keeping its ::error:: line and exit 2. The expression in the step name reuses the fallback pattern the file already uses for the OPERATION env entry, so a scheduled run with no inputs reads as safe-image-gc on the run page. (evidence: .github/workflows/deploy-capacity-maintenance.yml:59, .github/workflows/deploy-capacity-maintenance.yml; satisfies: key-change-0)",
      "Step 4 \u2014 the exit-code vocabulary inside Stage 2's script, same file. Around the single scripts/deploy/droplet-capacity.sh invocation only, run set +e, capture CAPACITY_STATUS=$?, and restore set -e on the following line. Add a test -f scripts/deploy/droplet-capacity.sh pre-check. Then classify: status 0 falls through to a clean exit; a failed pre-check or a captured 126 or 127 emits ::error:: and exits 21, meaning the capacity script could not be executed; any other nonzero status emits ::error:: naming OPERATION and the captured status and exits 20, meaning the capacity script ran and returned a nonzero verdict. Every nonzero capacity status therefore still yields a nonzero stage exit, a failing gate step and a failing job \u2014 the capture labels the failure and must never absorb it, and an implementation where any nonzero status can reach exit 0 is a defect to be rejected, not an optimisation. (evidence: .github/workflows/deploy-capacity-maintenance.yml:59; satisfies: key-change-0)",
      "Step 5 \u2014 Stage 2's gate step, same file, immediately after Stage 2. A run: step named 'Check capacity maintenance outcome', with no if: condition. It passes only when steps.maintenance.outcome is exactly success; on any other value it emits echo \"::error title=Capacity maintenance: ${{ inputs.operation || ''safe-image-gc'' }} stage::The capacity operation failed, exceeded its 10m budget, or returned a nonzero verdict; the remote exit code in this step's log names the class (20 capacity verdict nonzero, 21 capacity script not executable, 22 handoff identity mismatch, 2 refusal)\" and then exit 1. As with Step 2, the default branch is failure and the only pass is an exact success match, so this gate cannot turn a red remote run green. (evidence: .github/workflows/deploy-capacity-maintenance.yml:59, .github/workflows/deploy-capacity-maintenance.yml:54; satisfies: key-change-0, plan_contract:plan_architectural_tier_missing)",
      "Step 6 \u2014 the comments that make the run page self-explanatory, same file. Above the job's steps, document the three failure classes and the step name that identifies each, plus the exit-code vocabulary from Step 4. In the same comment that carries the timeouts, record the arithmetic: 2m plus 10m equals the 12m total remote budget the single step held before, and leaves roughly 3m of the unchanged timeout-minutes: 15 for runner spin-up, two action startups, two SSH handshakes and the two gate steps, so a per-stage command_timeout always fires before the job cap and the job cap remains a backstop rather than the active bound. Leave permissions contents: read, the concurrency group with cancel-in-progress: false, environment: production, the cron, the three inputs and their defaults, the INFRA-CRITICAL-085 input posture and the pinned action SHA untouched. (evidence: .github/workflows/deploy-capacity-maintenance.yml:54, .github/workflows/deploy-capacity-maintenance.yml; satisfies: key-change-0, plan_contract:plan_architectural_tier_missing)"
    ],
    "recursive_impact": "This request carries an empty impact_graph_refs[] list, so there is no entry with status unknown and nothing blocks dispatch on an unresolved impact node; the trace below is derived structurally from the one file in evidence rather than read from a graph the kernel supplied, and that provenance is stated so a reviewer does not mistake it for a machine closure. Consumer 1, the GitHub scheduler and the workflow_dispatch UI: the cron, the three inputs (operation, full_deploy, deploy_services) and their defaults are reused byte-for-byte, so the INFRA-CRITICAL-085 posture that no input names a release, image, registry or repository is preserved; status known. Consumer 2, the droplet's deploy control plane: the bootstrap contract (git show TARGET_SHA:scripts/deploy/deploy-paths.sh, source, materialize_deploy_checkout, cd DEPLOY_CHECKOUT_DIR) is reused as-is and merely re-homed into its own stage, with the handoff persisted in /var/lib/aqua/deploy, the directory the current script already creates with install -d; the one new artefact in it is capacity-maintenance.env; status known. Consumer 3, scripts/deploy/droplet-capacity.sh: invoked with the identical arguments and the identical CAPACITY_GC_MODE and CAPACITY_DISK_USAGE_MODE environment, so its bounded-GC behaviour and its verdict semantics are unchanged; status known, and the limit of that knowledge is recorded as R-P-05 because the script's internal exit vocabulary is not in evidence and the file is not in this request's allowed_scope. Consumer 4, the deploy capacity-preflight gate: it depends on this lane keeping the droplet under threshold between deploys, and a capacity alarm still fails the job, so the alarm channel the gate relies on is preserved verbatim. Consumer 5, the on-call operator reading CI runs: this is the surface the plan repairs. Transitive trace to the most extreme affected node: a production deploy blocked at the capacity-preflight gate because an earlier scheduled maintenance run failed opaquely, was triaged as machinery noise, and the GC that would have reclaimed the untagged generations never ran \u2014 the node this diagnosability fix protects, and the node the file's own header documents as having been reached before. This path is not an nx project, touches no libs/event-contracts/** interface and therefore has no NATS event consumer, and declares no *.entity.ts, so the machine impact closure of affected_surfaces beyond the file itself is empty and coverage.waivers is correspondingly empty; that claim is structural, because the coverage-manifest ref offered in evidence (coverage-manifest:plan-cyc-20261008T120143Z-auto-r1.json) was delivered skipped as malformed_ref and no manifest content was readable, and it is consistent with this request carrying no must_satisfy item of kind coverage_gap.",
    "risks": [
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59",
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "required_plan_changes": "The failing run's log signature is not in this request's admissible evidence \u2014 the only non-path ref offered, coverage-manifest:plan-cyc-20261008T120143Z-auto-r1.json, was delivered skipped as malformed_ref \u2014 so the plan must not claim to know which class that run hit, and it does not. The plan is therefore written class-agnostically: the root cause it claims is the one the file's structure proves (the lane cannot report its failure class), and the fix is specified so that whichever class recurs, the failing step name plus the relayed annotation name it. This also covers the possibility that the cause was purely host-side (droplet unreachable, secret rotation, environment protection): such a failure lands on Stage 1 and is named by the bootstrap gate's annotation rather than being removed, which is the honest claim for a workflow-file change. No plan step may be rewritten to assert a log-confirmed single cause unless a run log enters the evidence set through a new envelope.",
        "risk_id": "R-P-01",
        "severity": "MEDIUM",
        "summary": "The diagnosis is a structural root cause proven from the file, not a log-confirmed account of the specific failing run, because no run log is in the admissible evidence set."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59",
          ".github/workflows/deploy-capacity-maintenance.yml:54"
        ],
        "required_plan_changes": "continue-on-error: true is the mechanism that makes steps.<id>.outcome readable, and it is also the only way this change could do harm: a gate step that is skipped, or whose default branch passes, would convert a real failure into a green job. The plan therefore fixes three properties as hard requirements rather than guidance, and an implementation violating any of them must be rejected: each gate step carries no if: condition, so default step semantics run it whenever the job is healthy; the only passing branch is an exact match on the string success, with every other outcome value (failure, cancelled, skipped) falling through to exit 1; and Stage 2's remote script re-raises every nonzero capacity status under the kc-3 exit codes rather than absorbing any of them. The npx nx affected --target=test run on the deploy invariant suite is the executable check that the lane's boundary still holds after the restructuring.",
        "risk_id": "R-P-02",
        "severity": "HIGH",
        "summary": "A gate step that could pass while its SSH stage failed would turn a red run green \u2014 the one way this change could regress the signal it is meant to sharpen."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:54",
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "required_plan_changes": "Stage 1's 2m budget must bound a droplet git fetch --force --prune origin main plus a git show and materialize_deploy_checkout on a host whose contention this lane's own history records as severe. If it does not, the result is a correctly-named bootstrap-timeout failure rather than an opaque one, which is the designed behaviour; the correction is a budget move inside the arithmetic kc-4 documents, keeping the stage sum at or below the 12m total remote budget the single step holds today so no class gains budget at another's expense and the job's timeout-minutes: 15 stays a backstop. The plan must not absorb that budget risk by raising timeout-minutes, because that would make the job cap the active bound again and recreate the undifferentiated class the split removes.",
        "risk_id": "R-P-03",
        "severity": "MEDIUM",
        "summary": "Stage 1's 2m budget may prove tight for a fetch plus checkout on a contended droplet; the resulting failure is named rather than opaque, and the correction stays inside the documented arithmetic."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59",
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "required_plan_changes": "Two SSH sessions instead of one widen the handshake-failure surface and introduce a state handoff that did not exist before. The plan keeps both bounded: the RUN_IDENTITY stamp written by Stage 1 and compared by Stage 2 makes consumption of a stale handoff a hard exit 22 refusal rather than a silent run against an old checkout, which is structural prevention rather than detection; the env file is written by atomic rename so a partial read is impossible; Stage 2 only ever runs after Stage 1's gate passed; and the existing concurrency group with cancel-in-progress: false already serializes this workflow's own runs. Both stages must reuse the same pinned action SHA and the same secrets, so the added surface is a second handshake rather than a second configuration.",
        "risk_id": "R-P-04",
        "severity": "LOW",
        "summary": "A second SSH session and a new Stage 1 to Stage 2 state handoff add surface; the run-identity guard and atomic write keep a stale or partial handoff from being consumed silently."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "required_plan_changes": "Exit 20 separates 'the capacity script ran and reported nonzero' from exit 21 'the capacity script could not be executed'; it does not separate a capacity alarm from a crash inside the script, because that would require that script's own exit vocabulary and because safe-image-gc and gate both route to one scripts/deploy/droplet-capacity.sh gate invocation that performs GC and the verdict together. The plan must not assume an exit vocabulary it has no evidence for, and must not edit scripts/deploy/droplet-capacity.sh, which this request's allowed_scope does not name. Splitting the alarm from an in-script fault at the step boundary belongs to a separate envelope naming that script; this plan's claim is bounded to the three classes the one allowed file can separate.",
        "risk_id": "R-P-05",
        "severity": "LOW",
        "summary": "Within Stage 2 the capacity alarm and a fault inside the capacity script share exit 20, because separating them needs scripts/deploy/droplet-capacity.sh, which this request's allowed_scope does not include."
      }
    ],
    "rollback": "Single-file revert: git revert <commit-sha> of the one commit touching .github/workflows/deploy-capacity-maintenance.yml restores the single step, its 12m command_timeout and its script verbatim; no other file is in the diff, so there is nothing else to unwind, and no force push is required or permitted. Droplet-side state introduced by the change is one small file, /var/lib/aqua/deploy/capacity-maintenance.env, inside the directory the current script already creates with install -d. It is rewritten by atomic rename on every Stage 1 run and is never read by the reverted workflow, so the revert alone is a complete rollback and no host cleanup is required. An operator who prefers to leave no trace can additionally run rm -f /var/lib/aqua/deploy/capacity-maintenance.env on the droplet; that command is optional and has no effect on the reverted lane. /var/lib/aqua/deploy/deploy-paths.sh, the immutable checkout, the bare object store at /var/aqua-saas, containers, volumes and networks are untouched by this change in either direction.",
    "schema_version": 2,
    "summary": "The scheduled capacity lane executes its whole contract \u2014 GHCR prefix validation, remote-main SHA resolution, immutable-checkout bootstrap, bounded image GC, deep disk scan and the capacity verdict \u2014 inside the single step at .github/workflows/deploy-capacity-maintenance.yml:59 under one command_timeout: 12m nested in the job's timeout-minutes: 15 at line 54, so a bootstrap fault, a budget exhaustion and a capacity-alarm gate exit are one undifferentiated red run with no class attached. This revision splits that step into Stage 1 (resolve target plus bootstrap, 2m) and Stage 2 (capacity maintenance, 10m), hands DEPLOY_SHA, DEPLOY_CHECKOUT_DIR, IMAGE_PREFIX and RUN_IDENTITY across by atomic rename into /var/lib/aqua/deploy, and makes Stage 2 refuse any handoff not stamped with this run's identity. After each SSH stage a runner-side gate step reads steps.<id>.outcome \u2014 the mechanism being continue-on-error: true plus an id on the SSH step, so no step has to post-process its own log stream \u2014 and emits a titled ::error:: annotation before exiting 1; the pass branch is exactly outcome == 'success' and every other value fails, so the change cannot turn a red run green. Inside Stage 2 the capacity invocation's status is captured and re-raised under a documented exit-code vocabulary (2 refusal, 20 capacity verdict nonzero, 21 capacity script not executable, 22 handoff mismatch), which preserves the alarm channel verbatim while labelling it. The 2m plus 10m stage budgets hold today's 12m total remote budget exactly while leaving roughly three minutes under the unchanged 15m job cap for runner spin-up, two action startups, two SSH handshakes and the two gate steps, so the per-stage timeout is the active bound and the job cap stays a backstop.",
    "title": "Make the Deploy Capacity Maintenance lane name its failure class: two budgeted SSH stages, a run-identity-guarded handoff, fail-closed runner-side gates, and a documented remote exit-code vocabulary",
    "validation_commands": [
      {
        "cmd": "node tools/quality/quality.mjs format check-changed",
        "expected_exit": 0,
        "timeout_ms": 300000
      },
      {
        "cmd": "npx nx affected --target=lint",
        "expected_exit": 0,
        "timeout_ms": 900000
      },
      {
        "cmd": "npx nx affected --target=test",
        "expected_exit": 0,
        "timeout_ms": 1800000
      },
      {
        "cmd": "npm run type-check",
        "expected_exit": 0,
        "timeout_ms": 900000
      }
    ],
    "validation_plan": "All four declared commands come from the canonical executable suite the request's plan contract lists as admissible, and no command outside that operator-declared set is promised. (1) node tools/quality/quality.mjs format check-changed proves the rewritten YAML satisfies the repository's enforced changed-file format gate; a YAML restructuring is exactly the change class this gate exists to catch, and a nonzero exit here means the edit is malformed before any semantics matter. This is the direct proof for key-change-0's requirement that the edit land cleanly in the one named path. (2) npx nx affected --target=lint proves the changed file passes the repository's lint graph, which is where workflow and YAML lint surface where they are wired. (3) npx nx affected --target=test proves the deploy invariant suite still passes against the restructured lane \u2014 the no-checkout boundary for this lane was made executable in that suite when the pinned checkout landed, so this command is the executable check that Stage 1 still bootstraps the immutable checkout from the resolved SHA and that Stage 2 still runs from DEPLOY_CHECKOUT_DIR rather than the bare object store. It is also the command that would fail if the split broke the bootstrap contract, which is why it carries the longest budget. (4) npm run type-check proves no TypeScript surface regressed; for a YAML-only change it is a negative control, and a failure would mean the diff reached further than the one declared path. Together these prove both must_satisfy items: the format, lint and type-check results establish that the change is confined to .github/workflows/deploy-capacity-maintenance.yml and well-formed (key-change-0's paths constraint), and the deploy invariant suite establishes that the architectural restructuring preserved the bootstrap and dispatch contract the tier-3 claim depends on (plan_contract:plan_architectural_tier_missing). What these commands do not prove, stated rather than implied: no command in the admissible set executes a real SSH session against the production droplet, so the Stage 1 to Stage 2 handoff and the annotation relay are proven on the real host only by the lane's own next run. The first scheduled run after merge, or a workflow_dispatch with operation=report, is the operator-side observation that closes that gap, and its outcome is readable precisely because this change names the class \u2014 which is the property being delivered."
  },
  "request_id": "AIR-aria-primary-planner-bdcd6417f6a3",
  "role": "primary_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        ".github/workflows/deploy-capacity-maintenance.yml:59",
        ".github/workflows/deploy-capacity-maintenance.yml:54",
        ".github/workflows/deploy-capacity-maintenance.yml"
      ],
      "id": "key-change-0",
      "note": "The revision keeps the obligation's mandate and its single path, and replaces the restatement with concrete edits. Mandate part one, diagnose the root cause: the lone step anchored at .github/workflows/deploy-capacity-maintenance.yml:59 carries the lane's entire contract (GHCR prefix derivation plus regex refusal, remote-main SHA resolution, deploy-paths.sh bootstrap, materialize_deploy_checkout, and the case dispatch into scripts/deploy/droplet-capacity.sh) under one command_timeout: 12m inside the job's timeout-minutes: 15 at .github/workflows/deploy-capacity-maintenance.yml:54, so a bootstrap fault, a budget exhaustion and a capacity-alarm gate exit all render as the same single red step with no class attached. Mandate part two, land an architectural fix: four key changes split that step into two named, separately-budgeted SSH stages with an atomic run-identity-guarded handoff, add fail-closed runner-side gate steps that read steps.<id>.outcome and emit titled annotations, give the remote maintenance stage a documented exit-code vocabulary (2 refusal, 20 capacity verdict nonzero, 21 capacity script not executable, 22 handoff mismatch), and document the three classes plus the budget arithmetic in the file's comments. Every edit lands in .github/workflows/deploy-capacity-maintenance.yml and in no other file; permissions contents: read, the concurrency group, environment: production, the cron, the three inputs, the INFRA-CRITICAL-085 input posture and the pinned appleboy/ssh-action SHA are reused unchanged. One bound is stated plainly rather than papered over: the failing run's own log signature is not in this request's admissible evidence (the only non-path ref offered, coverage-manifest:plan-cyc-20261008T120143Z-auto-r1.json, was delivered skipped as malformed_ref), so the root cause this plan claims and fixes is the one the file's own structure proves \u2014 the lane cannot report which class failed \u2014 and that bound is registered as risk R-P-01 rather than hidden.",
      "verdict": "satisfied"
    },
    {
      "evidence_refs": [
        ".github/workflows/deploy-capacity-maintenance.yml:59",
        ".github/workflows/deploy-capacity-maintenance.yml:54"
      ],
      "id": "plan_contract:plan_architectural_tier_missing",
      "note": "plan_content.architectural_tier is now claimed as 3 (make the wrong behaviour detectable at build or test time), and the refused entry the gate named (plan_content.architectural_tier is required, one of 1, 2, 3, 4) is answered with a value from that set plus its justification in plan_content.architectural_approach. Tier 3 is the honest ceiling for this request, not a fallback: tier 1 would require structurally preventing the wrong behaviour, but the wrong behaviours are host-side (droplet disk exhaustion, unreachable host, control-plane bootstrap faults) and a workflow file cannot make them impossible; tier 2 would make correct host state the zero-effort default, which lives in scripts/deploy/ and on the droplet, and this request's allowed_scope names only .github/workflows/deploy-capacity-maintenance.yml. What the file can do structurally is guarantee every failure class arrives at CI with its own step name, its own budget and its own annotation \u2014 detection, which is tier 3. One element inside the plan is stronger than its governing tier (the RUN_IDENTITY guard makes reuse of a stale Stage 1 handoff structurally impossible rather than merely detectable), and the tier is still claimed as 3 because the defect the plan actually removes is the lane's inability to name its failure class. The plan's validation_commands are the four canonical entries the request declares admissible, so no command outside the operator-declared set is promised.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
