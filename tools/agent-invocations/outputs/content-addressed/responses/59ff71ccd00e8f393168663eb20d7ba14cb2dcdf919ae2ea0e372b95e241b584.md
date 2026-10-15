{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-38666959645",
  "claim_id": "claim_3b221ab5d07014ab",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:ad4d0c0796acf00f0143d3603cf4bc0d3faaf5d527964f0541920c86d20041e0",
    "agent_dispatch_model": "glm-5.3",
    "agent_subagent_type": "aria-challenger-planner",
    "agent_text": "{\"$schema\":\"aria/agent-response/v1\",\"request_id\":\"AIR-aria-challenger-planner-67f018d2beae\",\"claim_id\":\"plan-cyc-20261014T234932Z-auto\",\"agent_id\":\"aria-challenger-planner\",\"role\":\"challenger_plan\",\"status\":\"submitted\",\"satisfaction_matrix\":[{\"id\":\"key-change-0\",\"verdict\":\"satisfied\",\"note\":\"This competing plan's key_changes[0] carries obligation key_change_id ci-run-38640956459-key-change-001 with a description matching the plan_description (diagnose root cause and land an architectural fix for the failing 'Deploy Capacity Maintenance' workflow on head 99689e46bd86eb980ca2bad74df3c6b072eb4e90) and touches only .github/workflows/deploy-capacity-maintenance.yml. The independent consumer-backward scan supports the obligation from the file's own content: the only repair seams fully inside the allowed scope are the SHA-resolution seam (the fetch at :89 cannot update the 'origin/main' tracking ref that :90 reads, so the run either aborts under 'set -euo pipefail' or silently evaluates a stale main, contradicting the contract stated at :93-:98) and the composite 12m SSH command budget (:76) that the header at :5-:14 documents as the historically fatal exhaustion class.\",\"evidence_refs\":[\".github/workflows/deploy-capacity-maintenance.yml:59\",\".github/workflows/deploy-capacity-maintenance.yml:89\",\".github/workflows/deploy-capacity-maintenance.yml:90\"]}],\"evidence_refs\":[\".github/workflows/deploy-capacity-maintenance.yml\",\".github/workflows/deploy-capacity-maintenance.yml:14\",\".github/workflows/deploy-capacity-maintenance.yml:54\",\".github/workflows/deploy-capacity-maintenance.yml:59\",\".github/workflows/deploy-capacity-maintenance.yml:76\",\".github/workflows/deploy-capacity-maintenance.yml:89\",\".github/workflows/deploy-capacity-maintenance.yml:90\",\".github/workflows/deploy-capacity-maintenance.yml:98\",\".github/workflows/deploy-capacity-maintenance.yml:99\",\".github/workflows/deploy-capacity-maintenance.yml:101\",\".github/workflows/deploy-capacity-maintenance.yml:110\"],\"plan_content\":{\"schema_version\":2,\"title\":\"Challenger: pin capacity-maintenance SHA resolution to the fetch's own ref, classify failure seams, and split SSH phase budgets\",\"summary\":\"An independent consumer-backward scan of the failing single-step SSH workflow (job at :54, step at :59) finds exactly two repair seams fully inside the allowed scope. First, the SHA-resolution seam: 'git fetch --force --prune origin main' (:89) uses a one-sided refspec that updates FETCH_HEAD only, so the 'git rev-parse origin/main' it feeds (:90) consumes a tracking ref whose existence and freshness nothing in this repository guarantees \u2014 the run either aborts hard under 'set -euo pipefail' or silently pins maintenance to a stale main, contradicting the pinned-checkout contract the file itself states at :93-:98. Second, the composite 12m command budget (:76) concentrates fetch, helper bootstrap, checkout materialization, and a deep capacity gate (:106, :110) into one opaque envelope \u2014 the SSH-budget exhaustion class the header documents as historically fatal (:5-:14). The plan makes the SHA seam structurally correct (Tier 1: explicit-destination refspec fetch plus verified read and a guarded helper bootstrap), adds per-seam failure classification, and splits the SSH command into bounded bootstrap and operation steps; validation runs the canonical lint and format gates, with the next scheduled run as end-to-end proof.\",\"affected_surfaces\":[{\"paths\":[\".github/workflows/deploy-capacity-maintenance.yml\"]}],\"key_changes\":[{\"id\":\"ci-run-38640956459-key-change-001\",\"description\":\"Failing CI workflow 'Deploy Capacity Maintenance' (.github/workflows/deploy-capacity-maintenance.yml) on head 99689e46bd86eb980ca2bad74df3c6b072eb4e90; diagnose root cause + land architectural fix. Diagnosis from the file's own contract: the SHA-resolution seam \u2014 'git fetch --force --prune origin main' (:89) followed by 'git rev-parse origin/main' (:90) \u2014 reads a tracking ref this fetch does not update (a one-sided refspec re...",
    "notes": [
      "The round-1 coverage-manifest evidence ref (coverage-manifest:plan-cyc-20261014T234932Z-auto-r1.json) arrived marked skipped/malformed_ref and is therefore not cited anywhere in this envelope; the prior challenger rejection on this convergence surface for gh-run-list pseudo-refs is the governing precedent for excluding non-file references.",
      "This route provides no file tools, so verification was performed against the three content-hashed excerpts supplied in the request; the excerpts are mutually line-consistent (anchor agreements at lines 19, 94, and 99 across the 14-94, 19-99, and 1-116 ranges), which is the available cross-check, and the prompt-provided refs at :54 and :59 were used as authoritative anchors for the derived line numbers.",
      "No coverage waivers are claimed: the only affected surface is a workflow YAML with no nx project, NATS consumer, GraphQL surface, entity, or migration coupling in the provided repository view."
    ],
    "runtime_attempt_ledger_hash": "sha256:d4ee2bae0916eb1f0bf423de7f2d19f0c17bb241aba745f0f6ebb4e644d08e0f"
  },
  "evidence_refs": [
    ".github/workflows/deploy-capacity-maintenance.yml",
    ".github/workflows/deploy-capacity-maintenance.yml:14",
    ".github/workflows/deploy-capacity-maintenance.yml:54",
    ".github/workflows/deploy-capacity-maintenance.yml:59",
    ".github/workflows/deploy-capacity-maintenance.yml:76",
    ".github/workflows/deploy-capacity-maintenance.yml:89",
    ".github/workflows/deploy-capacity-maintenance.yml:90",
    ".github/workflows/deploy-capacity-maintenance.yml:98",
    ".github/workflows/deploy-capacity-maintenance.yml:99",
    ".github/workflows/deploy-capacity-maintenance.yml:101",
    ".github/workflows/deploy-capacity-maintenance.yml:110"
  ],
  "plan_content": {
    "affected_surfaces": [
      {
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      }
    ],
    "architectural_approach": "Tier mapping is stated per key change because the plan claims Tier 1 on the strength of the headline fix only. Key change 1 is Tier 1 (make it impossible): fetching with an explicit destination refspec and reading exactly that ref makes it structurally impossible to resolve anything other than the tip the fetch just produced \u2014 the stale-or-missing-tracking-ref defect class ceases to exist rather than being caught. Key change 2 is Tier 3 (make it detectable): per-seam exit codes and annotations with a PHASE marker make every remaining failure self-classifying in the check annotation. Key change 3 is structural bounding in the Tier 2 direction: phase-separated command timeouts make 'each phase within its own budget' the default shape of the workflow instead of a shared-envelope property. Honest scoping of the Tier 1 claim: it covers the SHA-resolution defect class; environmental seams (host reachability, secrets, remote misconfiguration) are made detectable, not impossible.",
    "architectural_tier": 1,
    "context": "Teaching framing. What this workflow is: the only scheduled guard keeping the production droplet's image cache under the deploy capacity threshold \u2014 every deploy pulls roughly 1.85GB x 13 service images and leaves the prior generation untagged, and without this sweep the capacity preflight blocks deploys; the file's own header documents the #695 / 28332208818 / 28330781676 incidents (:5-:14). What must be done: the required check is failing on head 99689e46, so diagnose which seam inside the one allowed file breaks and land an architectural fix there. Why it matters and what breaks if skipped: a red or silently stale maintenance lane lets untagged generations accumulate until deploys re-enter the documented capacity-block regime, and the pinned-checkout contract the file claims ('scheduled and manual runs both evaluate the remote's current main', :93-:98) stays unenforced. Downstream surfaces affected: the GitHub required check, the droplet-side capacity preflight that consumes the swept state, and the deploy-digitalocean prepare step that shares the same ghcr.io/${REPO,,} prefix derivation (:68-:70) \u2014 deliberately left untouched. What evidence proves the result: the canonical lint and format gates for the file change, GitHub's workflow-schema parse at push, and the next scheduled run (cron '0 */6 * * *', :15) completing with no '::error::capacity-maintenance' annotation; a failing run now names its seam, converting unknowns into classified evidence.",
    "coverage": {
      "waivers": []
    },
    "evidence_refs": [
      ".github/workflows/deploy-capacity-maintenance.yml",
      ".github/workflows/deploy-capacity-maintenance.yml:14",
      ".github/workflows/deploy-capacity-maintenance.yml:54",
      ".github/workflows/deploy-capacity-maintenance.yml:59",
      ".github/workflows/deploy-capacity-maintenance.yml:76",
      ".github/workflows/deploy-capacity-maintenance.yml:89",
      ".github/workflows/deploy-capacity-maintenance.yml:90",
      ".github/workflows/deploy-capacity-maintenance.yml:98",
      ".github/workflows/deploy-capacity-maintenance.yml:99",
      ".github/workflows/deploy-capacity-maintenance.yml:101",
      ".github/workflows/deploy-capacity-maintenance.yml:110"
    ],
    "key_changes": [
      {
        "description": "Failing CI workflow 'Deploy Capacity Maintenance' (.github/workflows/deploy-capacity-maintenance.yml) on head 99689e46bd86eb980ca2bad74df3c6b072eb4e90; diagnose root cause + land architectural fix. Diagnosis from the file's own contract: the SHA-resolution seam \u2014 'git fetch --force --prune origin main' (:89) followed by 'git rev-parse origin/main' (:90) \u2014 reads a tracking ref this fetch does not update (a one-sided refspec records FETCH_HEAD only), so under 'set -euo pipefail' an absent ref aborts the run and a present-but-stale ref silently evaluates an old main, contradicting :93-:98. Fix (Tier 1): replace the fetch with an explicit destination refspec '+refs/heads/main:refs/remotes/origin/main' and read 'git rev-parse --verify refs/remotes/origin/main', making the evaluated SHA by construction the tip the fetch just produced; add a 'git cat-file -e \"${TARGET_SHA}:scripts/deploy/deploy-paths.sh\"' existence guard before the :99 bootstrap that emits a distinct '::error::' annotation and exit code so a missing deploy helper self-identifies instead of surfacing as a bare git-show failure.",
        "id": "ci-run-38640956459-key-change-001",
        "imports": [],
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Make every remaining failure seam self-classifying (Tier 3): set a PHASE variable around each remote-script region (resolve, bootstrap, checkout-materialize, capacity-operation), install an ERR trap emitting '::error::capacity-maintenance phase=${PHASE}' before abort, and assign distinct exit codes per seam (identity regex keeps exit 2 at :84; helper-missing = 3; materialization = 4; capacity operation = 5) so the required-check annotation names the failing seam rather than an opaque SSH abort. Stated limit: a command_timeout kill at :76 may terminate the session before the trap executes; attribution for that class is delivered by the step split in the next key change, not by this trap.",
        "id": "challenger-capacity-phase-classification",
        "imports": [],
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Split the single SSH command (:59-:115) into two sequential appleboy/ssh-action steps inside the same job and concurrency group (:49-:51): step A 'resolve target and bootstrap immutable checkout' \u2014 identity check, explicit-refspec fetch, verified SHA read, deploy-paths.sh guard, materialize_deploy_checkout, persist DEPLOY_SHA to /var/lib/aqua/deploy/target-sha \u2014 with its own command_timeout (4m); step B 'run capacity operation' \u2014 read target-sha, source the persisted deploy-paths.sh at /var/lib/aqua/deploy, cd to DEPLOY_CHECKOUT_DIR, and run the unchanged operation case block (:104-:115) \u2014 with command_timeout 10m. Each phase's budget becomes independently bounded and independently attributable, so the composite can no longer exhaust one shared 12m envelope (:76) without the check naming which phase did it. The env mapping (:61-:71, :77) is duplicated unchanged on both steps so IMAGE_REPOSITORY/IMAGE_PREFIX derivation keeps parity with the deploy-digitalocean prepare step noted at :68-:70.",
        "id": "challenger-capacity-budget-split",
        "imports": [],
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      }
    ],
    "plan_steps_detailed": [
      "Step 1 \u2014 diagnosis from admissible evidence only: record that no run log is included in evidence_refs (the round-1 coverage-manifest ref arrived malformed and is not cited), so root cause is established by structural elimination across the two in-scope seams (:76, :89-:90) plus classification of residuals, not by log reading.",
      "Step 2 \u2014 implement key change 1 in the remote script: explicit-destination refspec fetch, 'git rev-parse --verify refs/remotes/origin/main', and the cat-file existence guard for scripts/deploy/deploy-paths.sh before :99, with its own '::error::' annotation and exit code 3.",
      "Step 3 \u2014 implement key change 2: PHASE markers, ERR trap, and the per-seam exit-code table (2 identity, 3 helper, 4 materialization, 5 capacity operation).",
      "Step 4 \u2014 implement key change 3: split the step at :59 into bootstrap and operation steps with command_timeouts 4m and 10m, the target-sha state-file handoff under /var/lib/aqua/deploy, duplicated env mapping, and the operation case block (:104-:115) moved verbatim into step B. Leave cron (:15), permissions (:46-:47), concurrency (:49-:51), environment (:57), and the secrets mapping (:73-:75) untouched.",
      "Step 5 \u2014 diff self-review against the excerpted file content (lines 1-116): confirm only the intended seams changed and that IMAGE_REPOSITORY/IMAGE_PREFIX derivation (:65-:86) is byte-identical, preserving parity with the deploy-digitalocean prepare derivation noted at :68-:70."
    ],
    "recursive_impact": "Consumer-backward traversal (challenger lens; the primary reads implementation-forward, this scan starts at the consumers and meets the changed code last). (1) Terminal consumer: the required check \u2014 it fails when the single step at :59 exits non-zero, exceeds command_timeout 12m (:76), or the job exceeds timeout-minutes 15 (:56). (2) The step's remote script consumes env-mapped inputs (:65-:71, sound for both schedule and dispatch via the || fallbacks) and droplet-side producers: the bare object store /var/aqua-saas (:88, :93-:94), origin/main (:89-:90), scripts/deploy/deploy-paths.sh at the resolved SHA (:99), materialize_deploy_checkout (:101), and scripts/deploy/droplet-capacity.sh (:106, :110). None of those producers is modifiable under the allowed scope, so every repair must land at the workflow's own seams. (3) The one producer/consumer pair fully in scope is TARGET_SHA: produced by a one-sided-refspec fetch plus a tracking-ref read, consumed by the bootstrap (:99) and the checkout (:101). (4) Budget seam: fetch + bootstrap + materialization + deep disk-usage gate share one 12m command \u2014 the exhaustion class the header names (:5-:14). Coupling check: no nx project, NATS event consumer, GraphQL surface, DB entity, or migration references a workflow YAML; the expected impact closure is empty, so no coverage waivers are claimed.",
    "risks": [
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59",
          ".github/workflows/deploy-capacity-maintenance.yml:73"
        ],
        "id": "CH-RISK-001",
        "severity": "HIGH",
        "summary": "The actual abort cause of run ci-run-38640956459 is not observable from the admissible evidence: no run log is included, and the round-1 coverage-manifest ref arrived malformed and skipped, so an environment-side cause (missing production-environment secret at :73-:75, unreachable host, environment approval) cannot be ruled out and would not be repaired by any in-file change; if the next run still fails, its new seam annotation is the discriminating evidence and an operator escalation with the run log is required."
      },
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:99",
          ".github/workflows/deploy-capacity-maintenance.yml:101",
          ".github/workflows/deploy-capacity-maintenance.yml:110"
        ],
        "id": "CH-RISK-002",
        "severity": "MEDIUM",
        "summary": "Every executable producer the script consumes \u2014 deploy-paths.sh, materialize_deploy_checkout, droplet-capacity.sh \u2014 lives outside the allowed scope; if the defect is in one of those, this workflow-side change classifies the failure but cannot repair it, and the fix must be routed to the owning surface in a follow-on request."
      },
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:89",
          ".github/workflows/deploy-capacity-maintenance.yml:98"
        ],
        "id": "CH-RISK-003",
        "severity": "MEDIUM",
        "summary": "The explicit-destination fetch assumes the bare store's 'origin' remote points at the true upstream; a mis-pointed remote yields a structurally valid but wrong 'current main'. The workflow cannot detect remote misconfiguration in-scope; after the fix the resolved SHA provably equals what the configured remote serves, which is exactly the contract stated at :98 and the strongest guarantee reachable from this file."
      },
      {
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:50",
          ".github/workflows/deploy-capacity-maintenance.yml:76"
        ],
        "id": "CH-RISK-004",
        "severity": "LOW",
        "summary": "The step split adds one SSH session per maintenance run; connect overhead grows by a single session while each phase's budget shrinks, and the concurrency group at :49-:51 still serializes runs, so the every-6h cadence contract is unchanged."
      }
    ],
    "rollback": "Single-file revert: 'git revert' of the one commit implementing these key changes restores the exact head 99689e46 workflow, since the file is the only touched surface. Droplet-side residue: the fix writes /var/lib/aqua/deploy/target-sha alongside the design's existing /var/lib/aqua/deploy/deploy-paths.sh (:98-:99); after revert that file is inert because nothing reads it, and it can be deleted on the host with no contract effect. No migrations, no event contracts, no application state, and the schedule cadence is unchanged throughout.",
    "schema_version": 2,
    "summary": "An independent consumer-backward scan of the failing single-step SSH workflow (job at :54, step at :59) finds exactly two repair seams fully inside the allowed scope. First, the SHA-resolution seam: 'git fetch --force --prune origin main' (:89) uses a one-sided refspec that updates FETCH_HEAD only, so the 'git rev-parse origin/main' it feeds (:90) consumes a tracking ref whose existence and freshness nothing in this repository guarantees \u2014 the run either aborts hard under 'set -euo pipefail' or silently pins maintenance to a stale main, contradicting the pinned-checkout contract the file itself states at :93-:98. Second, the composite 12m command budget (:76) concentrates fetch, helper bootstrap, checkout materialization, and a deep capacity gate (:106, :110) into one opaque envelope \u2014 the SSH-budget exhaustion class the header documents as historically fatal (:5-:14). The plan makes the SHA seam structurally correct (Tier 1: explicit-destination refspec fetch plus verified read and a guarded helper bootstrap), adds per-seam failure classification, and splits the SSH command into bounded bootstrap and operation steps; validation runs the canonical lint and format gates, with the next scheduled run as end-to-end proof.",
    "title": "Challenger: pin capacity-maintenance SHA resolution to the fetch's own ref, classify failure seams, and split SSH phase budgets",
    "validation_commands": [
      {
        "cmd": "npx nx affected --target=lint",
        "expected_exit": 0,
        "timeout_ms": 1800000
      },
      {
        "cmd": "node tools/quality/quality.mjs format check-changed",
        "expected_exit": 0,
        "timeout_ms": 600000
      }
    ],
    "validation_plan": "Declared canonical commands: 'npx nx affected --target=lint' and 'node tools/quality/quality.mjs format check-changed' \u2014 the change is a single YAML file, the nx test/type-check graphs are unaffected by it, and the canonical suite runs them regardless of declaration. GitHub parses and validates the workflow schema at push. The operative end-to-end proof is the next scheduled run (cron '0 */6 * * *', :15) completing with no '::error::capacity-maintenance' annotation; any failing run now names its seam via the new annotations, which converts a residual unknown into classified evidence for the next round. A workflow_dispatch run with operation=report exercises the report branch (:106) at lower cost before the scheduled window."
  },
  "request_id": "AIR-aria-challenger-planner-67f018d2beae",
  "role": "challenger_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        ".github/workflows/deploy-capacity-maintenance.yml:59",
        ".github/workflows/deploy-capacity-maintenance.yml:89",
        ".github/workflows/deploy-capacity-maintenance.yml:90"
      ],
      "id": "key-change-0",
      "note": "This competing plan's key_changes[0] carries obligation key_change_id ci-run-38640956459-key-change-001 with a description matching the plan_description (diagnose root cause and land an architectural fix for the failing 'Deploy Capacity Maintenance' workflow on head 99689e46bd86eb980ca2bad74df3c6b072eb4e90) and touches only .github/workflows/deploy-capacity-maintenance.yml. The independent consumer-backward scan supports the obligation from the file's own content: the only repair seams fully inside the allowed scope are the SHA-resolution seam (the fetch at :89 cannot update the 'origin/main' tracking ref that :90 reads, so the run either aborts under 'set -euo pipefail' or silently evaluates a stale main, contradicting the contract stated at :93-:98) and the composite 12m SSH command budget (:76) that the header at :5-:14 documents as the historically fatal exhaustion class.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
