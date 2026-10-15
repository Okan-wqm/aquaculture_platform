{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-38683514532",
  "claim_id": "claim_d35f9c0c6f5194f3",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:bd533ad74bc9a9afbaeb8f0595cb782c8cbfc079742bb51010c70636497d8f24",
    "agent_dispatch_model": "glm-5.3",
    "agent_subagent_type": "aria-primary-planner",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-primary-planner-12e4ce623d54\",\n  \"claim_id\": \"AIR-aria-primary-planner-12e4ce623d54\",\n  \"agent_id\": \"aria-primary-planner\",\n  \"role\": \"primary_plan\",\n  \"status\": \"submitted\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"The revision decomposes the r1 obligation (diagnose root cause + land architectural fix) into concrete steps that stay inside the single allowed file: kc-diagnose keeps id ci-run-38680893046-key-change-001 and classifies the failure from run 38680893046's step log; kc-prologue-posix, kc-guard-posix, kc-sha-fetchhead and kc-exit-classification land the architectural fix. The failing step is the workflow's only step (line 59) inside its only job (line 54), and its script block owns every code path between SSH connect and exit, so the diagnosis-and-fix arc is fully expressible within that one file.\",\n      \"evidence_refs\": [\n        \".github/workflows/deploy-capacity-maintenance.yml:59\",\n        \".github/workflows/deploy-capacity-maintenance.yml:54\"\n      ]\n    },\n    {\n      \"id\": \"plan_contract:plan_architectural_tier_missing\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"plan_content.architectural_tier is claimed as 1, scoped to the structural failure classes the rewrite removes: POSIX-only script syntax covering the whole prologue including the 'set -euo pipefail' line CR-003 flagged, and FETCH_HEAD-anchored SHA resolution. Every plan_content.validation_commands entry names one of the four canonical suite commands, now including 'node tools/quality/quality.mjs format check-changed' whose omission CR-002 flagged; no key change touches a TypeScript or JavaScript source file, so no imports declarations are due.\",\n      \"evidence_refs\": [\n        \".github/workflows/deploy-capacity-maintenance.yml\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \".github/workflows/deploy-capacity-maintenance.yml:59\",\n    \".github/workflows/deploy-capacity-maintenance.yml:54\",\n    \".github/workflows/deploy-capacity-maintenance.yml\"\n  ],\n  \"plan_content\": {\n    \"schema_version\": 2,\n    \"title\": \"Deploy Capacity Maintenance r2: classify run 38680893046, then make the SSH step's remote script POSIX-safe end-to-end and FETCH_HEAD-anchored (Tier 1)\",\n    \"summary\": \"The failing run has exactly one executable step \u2014 the appleboy/ssh-action step at .github/workflows/deploy-capacity-maintenance.yml:59 inside the single job at line 54 \u2014 so every failure lives in that step's remote script, its transport/secret surface, or the droplet-capacity.sh verdict it invokes. The script text itself makes three failure classes live: the prologue 'set -euo pipefail' (pipefail is not POSIX), the bash-only identity guard (the lowercase expansion and the regex conditional), and 'git rev-parse origin/main' resolution that presumes remote-tracking refs the file's own comment calls a persistent bare object store. This revision claims architectural_tier 1 scoped to those structural classes \u2014 after the rewrite the script contains no shell-specific syntax in any line, and SHA resolution is anchored to FETCH_HEAD, which every successful explicit fetch writes \u2014 while transport failures and genuine capacity verdicts are made explicitly detectable and surface as a blocked result with the log line, never as a weakened gate. It resolves CR-001 (tier claim now present), CR-002 (diagnosis method, per-class fixes, full canonical validation list) and CR-003 (the portability rewrite covers the whole prologue, and the lost pipefail guarantee is compensated by the mandatory shape validation that follows the lowering pipeline).\",\n    \"context\": \"Trigger: CI run 38680893046 failed on head 99689e46bd86eb980ca2bad74df3c6b072eb4e90 in the workflow's only step, 'Run capacity operation through production deploy control plane' (.github/workflows/deploy-capacity-maintenance.yml:59), inside its only job, 'capacity-maintenance' (line 54). Why a red run matte...",
    "revision": {
      "addresses_review_risk_ids": [
        "CR-001",
        "CR-002",
        "CR-003"
      ]
    },
    "runtime_attempt_ledger_hash": "sha256:4f0a5b4c441ac7af625b721ae9a1df109c4ded926bf624885df5f84463865950"
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
    "architectural_approach": "Tier 1, scoped to the structural failure classes the rewrite removes; for the classes this file cannot prevent (transport or secret failure, genuine capacity verdict) the architecture is honest detectability, never a weakened gate. CR-003 correctly widens the S1 claim: rewriting only the two guard constructs leaves 'set -euo pipefail' as a POSIX-family parse abort at the script's first line, so this revision makes the whole prologue POSIX-portable \u2014 'set -eu' replaces 'set -euo pipefail' \u2014 and rewrites the guard without shell-specific syntax, after which no POSIX-conformant login shell can misparse any line of the script: the wrong behaviour is prevented by construction, not detected after the fact. The pipefail trade is weighed explicitly: after the rewrite the script contains exactly one pipeline (the printf-through-tr lowercase lowering), POSIX pipeline status is the last command's status, so a failed tr (command not found, status 127) still trips set -e, and a wrong lowering cannot pass silently because the mandatory shape validation that immediately follows exits 2 on any mismatch \u2014 the guarantee pipefail provided for this pipeline is recovered by validation that exists for its own reason. For class S2, FETCH_HEAD anchoring is Tier 1 because FETCH_HEAD is written by every successful explicit fetch: 'git rev-parse --verify FETCH_HEAD' cannot fail for lack of remote-tracking-ref maintenance the way 'git rev-parse origin/main' can in a persistent bare object store.",
    "architectural_tier": 1,
    "context": "Trigger: CI run 38680893046 failed on head 99689e46bd86eb980ca2bad74df3c6b072eb4e90 in the workflow's only step, 'Run capacity operation through production deploy control plane' (.github/workflows/deploy-capacity-maintenance.yml:59), inside its only job, 'capacity-maintenance' (line 54). Why a red run matters, in cause-and-effect order: each production deploy pulls a fresh image per service (the header documents roughly 1.85GB across 13 services) and leaves the prior generation untagged; without the 6-hourly safe-image-GC sweep those generations accumulate until the deploy capacity-preflight gate blocks \u2014 the #695 failure class the file's own header names. A red lane therefore means either the janitor itself is broken and the droplet refills until deploys block again, or a genuine capacity signal is lost inside a failure the log cannot yet classify. The step's script block owns every code path between SSH connect and exit (identity guard, fetch, SHA resolution, checkout bootstrap, the droplet-capacity.sh invocation), so the failure is diagnosable from that script's text plus the run's step log, and the text itself makes three classes live: the non-POSIX 'set -euo pipefail' prologue, the bash-only guard constructs, and origin/main resolution in a bare store.",
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
        "description": "Diagnose before editing (mutates no repository file): read CI run 38680893046's step log and annotations for the single SSH step at .github/workflows/deploy-capacity-maintenance.yml:59 and classify the failure into exactly one class \u2014 S1 shell-parse rejection of the remote script (log shows 'Bad substitution', 'Syntax error', or 'set: Illegal option -o pipefail', the last at the script's first line per CR-003), S2 target-SHA resolution failure in the bare store ('unknown revision' or 'ambiguous argument' for origin/main, a fetch auth or network failure, or a missing scripts/deploy/deploy-paths.sh at the resolved SHA), S3 transport surface (secret resolution, appleboy action error, command_timeout 12m exceeded inside timeout-minutes 15), S4 droplet-capacity.sh gate verdict below threshold after the bounded GC. The recorded class steers the branch in the final plan step and is quoted in the commit message as the root-cause diagnosis.",
        "id": "ci-run-38680893046-key-change-001",
        "imports": []
      },
      {
        "description": "Make the remote script's prologue POSIX-portable (CR-003): replace 'set -euo pipefail' \u2014 whose '-o pipefail' is rejected by dash, busybox ash and strict POSIX sh \u2014 with 'set -eu'. The lost pipefail guarantee is weighed and compensated: after this plan the script contains exactly one pipeline (the printf-through-tr lowering introduced by kc-guard-posix); POSIX pipeline status is the last command's, so a failed tr still trips set -e, and a wrong lowering is rejected by the immediately following shape validation, so no silent mid-pipeline failure path remains.",
        "id": "kc-prologue-posix",
        "imports": [],
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Replace the bash-only identity-guard constructs \u2014 the lowercase parameter expansion on IMAGE_REPOSITORY and the double-bracket regex conditional \u2014 with POSIX-portable equivalents: derive the prefix as ghcr.io/ followed by the repository lowered via printf piped through tr '[:upper:]' '[:lower:]', then validate with a case-glob on ghcr.io/*/* plus per-component checks that accept exactly the grammar the regex accepted: exactly two components after ghcr.io/ (a second slash in the suffix is a refusal), each component starting with a lowercase alphanum and continuing with lowercase alphanums, dots, underscores or hyphens. Preserve the identical error-message intent and the identical exit 2 refusal, so the INFRA-CRITICAL-085 property \u2014 no dispatcher input names an image, registry or repository \u2014 is unchanged and the accepted set is neither narrowed nor widened.",
        "id": "kc-guard-posix",
        "imports": [],
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Anchor target-SHA resolution to the fetch itself: keep 'cd /var/aqua-saas' and 'git fetch --force --prune origin main' unchanged, but resolve TARGET_SHA with 'git rev-parse --verify FETCH_HEAD' instead of 'git rev-parse origin/main', so resolution cannot depend on refs/remotes/origin/main being configured or current in the persistent bare object store \u2014 FETCH_HEAD is written by every successful explicit fetch. Keep the DEPLOY_SHA export, the 'git show' bootstrap of scripts/deploy/deploy-paths.sh into /var/lib/aqua/deploy, the source of deploy-paths.sh, materialize_deploy_checkout, and the cd into DEPLOY_CHECKOUT_DIR byte-identical, so the checkout contract shared with the rest of the deploy control plane is untouched.",
        "id": "kc-sha-fetchhead",
        "imports": [],
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      },
      {
        "description": "Make every failure of this lane diagnosable from the run log alone: capture the capacity invocation's exit status and, immediately before exiting with that same status, echo one greppable terminal line of the form 'capacity-maintenance: class=S1-or-S2-or-S3-or-S4-or-gate stage=stage detail=one-line'; add the same marker to each early-exit path (identity refusal, fetch, rev-parse, show and bootstrap failures, unsupported operation). Exit codes and gate semantics are unchanged \u2014 no '|| true', no softened assertion, no suppressed verdict \u2014 because appleboy prefixes remote output and ::error:: text from the remote side never renders as a runner annotation.",
        "id": "kc-exit-classification",
        "imports": [],
        "paths": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ]
      }
    ],
    "plan_steps_detailed": [
      "1. Diagnose (kc-diagnose, serves key-change-0): read run 38680893046's step log and annotations for the single SSH step at line 59; record the S1-S4 class and the exact failing line in the working notes and later the commit message. No repository file is mutated by this step.",
      "2. Apply kc-prologue-posix: replace 'set -euo pipefail' with 'set -eu' so the script's first line is POSIX-conformant (CR-003), with the pipefail trade compensated as described in the key change.",
      "3. Apply kc-guard-posix: rewrite the IMAGE_PREFIX derivation and shape validation POSIX-portably, preserving the accepted grammar, the error intent and exit 2 on refusal.",
      "4. Apply kc-sha-fetchhead: switch TARGET_SHA resolution to 'git rev-parse --verify FETCH_HEAD' after the unchanged fetch; leave the bootstrap and checkout sequence untouched.",
      "5. Apply kc-exit-classification: add the greppable 'capacity-maintenance: class=... stage=... detail=...' terminal line on every exit path without altering any exit code.",
      "6. Branch on the diagnosed class (serves key-change-0): S1 or S2 \u2014 the structural fixes above are the repair, proceed to validation. S3 or S4 \u2014 land steps 2-5 as correct hardening anyway (they are evidenced defects of the file's text regardless), and return the implementer result as blocked citing the exact log line, because the root cause then lives on the droplet, secrets, or scripts/deploy/droplet-capacity.sh surfaces this request's allowed file cannot honestly repair; do not adjust command_timeout, timeout-minutes, or gate semantics to force a green run.",
      "7. Validation (serves plan_contract:plan_architectural_tier_missing and key-change-0): run the four canonical suite commands; the format check-changed gate is the one that actually parses and formats this YAML edit. After merge, the operator re-dispatches the workflow with operation=report to exercise the dispatch path end-to-end, and the next '0 */6 * * *' tick exercises the schedule fallback path (OPERATION resolving to safe-image-gc when inputs are empty)."
    ],
    "recursive_impact": "The request carries no impact_graph_refs, so no graph node is unknown and nothing blocks dispatch. Tracing consumers transitively from the single affected path: (a) the GitHub scheduler (cron '0 */6 * * *') and the workflow_dispatch dispatcher, whose env block falls back on schedule events (OPERATION to safe-image-gc, FULL_DEPLOY to true, DEPLOY_SERVICES to all); (b) the droplet-side scripts the step invokes at the resolved SHA \u2014 scripts/deploy/deploy-paths.sh, bootstrapped via 'git show' into /var/lib/aqua/deploy, sourced, and used by materialize_deploy_checkout, and scripts/deploy/droplet-capacity.sh for the report and gate verbs. The most extreme affected node is the production droplet's deploy capacity itself: the gate this lane protects is the same capacity-preflight surface the file header names as the #695 root cause. Contracts preserved exactly: the same four forwarded env vars (OPERATION, FULL_DEPLOY, DEPLOY_SERVICES, IMAGE_REPOSITORY), the identical accepted image-prefix grammar and exit-2 refusal, the same DEPLOY_SHA bootstrap sequence, and value parity for the ghcr.io prefix the deploy-digitalocean prepare step derives from github.repository, a shared derivation the file's own comment at the IMAGE_REPOSITORY env records. Coverage closure for a single YAML path is empty \u2014 it is not an nx project source, it touches no libs/event-contracts path (no NATS consumer nodes) and no entity file (no migration coupling) \u2014 so coverage.waivers is empty and no coverage_gap items arise.",
    "risks": [
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "mitigation": "Do not soften: the gate verdict is production signal; the blocked result carries the exact log line so the operator can route the droplet-side or capacity-side repair with evidence.",
        "required_plan_changes": "Return the implementer result as blocked citing the exact log line, and propose an operator-routed envelope for the droplet-side, secret or droplet-capacity.sh surface as enabling surfaces.",
        "risk_id": "R1",
        "severity": "HIGH",
        "summary": "If the diagnosed class is S4 (capacity below threshold after bounded GC) or S3 (transport or secret failure), no edit inside the allowed file honestly greens the run; the plan lands the evidenced hardening and requires a blocked result citing the log line, which blocks convergence this cycle by design."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "mitigation": "FETCH_HEAD is strictly the tip just fetched, so it equals what a maintained origin/main would read; the classification line makes any future resolution failure explicit in the log.",
        "required_plan_changes": "If the failing run's log shows the bare store does maintain remote-tracking refs correctly, record that observation in the commit message so the divergence is an evidenced choice rather than an assumption.",
        "risk_id": "R2",
        "severity": "MEDIUM",
        "summary": "FETCH_HEAD-based resolution deliberately diverges from the origin/main pattern the rest of the deploy control plane may use, which could hide a store misconfiguration the deploy lane would have surfaced."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "mitigation": "kc-guard-posix pins the exact grammar (ghcr.io owner slash repo, exactly two components, each starting lowercase-alphanum and continuing the accepted character set, identical exit 2 refusal); the classification line names the refusal path so a wrong rejection is visible on the next run.",
        "required_plan_changes": "If implementation cannot express a grammar-preserving case-glob, revise the key change to add a character-class loop rather than loosening the accepted set.",
        "risk_id": "R3",
        "severity": "MEDIUM",
        "summary": "A portable rewrite of the regex guard can silently narrow or widen the accepted grammar, weakening the INFRA-CRITICAL-085 refusal semantics."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "mitigation": "Post-rewrite pipeline inventory is exactly one (printf through tr): last-command status covers a failed tr under set -e, and the mandatory shape validation that follows rejects any wrong lowering with exit 2, so no silent mid-pipeline failure path remains.",
        "required_plan_changes": "If implementation adds any new pipeline to the script, it must re-establish explicit per-pipeline status checking or the plan must be revised to re-weigh the prologue choice.",
        "risk_id": "R4",
        "severity": "MEDIUM",
        "summary": "Dropping pipefail (CR-003) removes a failure-detection guarantee for mid-pipeline commands."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml:59"
        ],
        "mitigation": "Accept the annotation limitation explicitly rather than pretending the directives work; the greppable line is the honest mechanism available from inside this file.",
        "required_plan_changes": "None within this request's allowed scope; annotation surfacing would require a runner-side change on a different surface.",
        "risk_id": "R5",
        "severity": "LOW",
        "summary": "The existing ::error:: directives in the remote script never render as runner annotations because appleboy prefixes remote output; the new marker improves log greppability but not annotation surfacing."
      },
      {
        "affected_files": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "evidence_refs": [
          ".github/workflows/deploy-capacity-maintenance.yml"
        ],
        "mitigation": "The fallback expression itself is unchanged by this plan; the next scheduled tick is the confirming observation, and the classification line makes any branch-specific failure identifiable.",
        "required_plan_changes": "If the next tick fails on the fallback branch, open a follow-up envelope with that tick's log line as evidence.",
        "risk_id": "R6",
        "severity": "LOW",
        "summary": "The schedule-only fallback branch (empty inputs selecting safe-image-gc) is not exercised by a dispatch-time validation run, so a defect unique to that branch would only appear at the next cron tick."
      }
    ],
    "rollback": "Single-command revert of the merged commit ('git revert' of the merge SHA): the workflow file is the only mutated surface. The droplet-side state the script touches \u2014 the /var/lib/aqua/deploy/deploy-paths.sh bootstrap copy and the materialized checkout \u2014 is recomputed from the freshly fetched SHA on every run, so the revert restores prior behaviour on the next scheduled or manual run with no persistent-state migration and no coordination with other lanes.",
    "schema_version": 2,
    "summary": "The failing run has exactly one executable step \u2014 the appleboy/ssh-action step at .github/workflows/deploy-capacity-maintenance.yml:59 inside the single job at line 54 \u2014 so every failure lives in that step's remote script, its transport/secret surface, or the droplet-capacity.sh verdict it invokes. The script text itself makes three failure classes live: the prologue 'set -euo pipefail' (pipefail is not POSIX), the bash-only identity guard (the lowercase expansion and the regex conditional), and 'git rev-parse origin/main' resolution that presumes remote-tracking refs the file's own comment calls a persistent bare object store. This revision claims architectural_tier 1 scoped to those structural classes \u2014 after the rewrite the script contains no shell-specific syntax in any line, and SHA resolution is anchored to FETCH_HEAD, which every successful explicit fetch writes \u2014 while transport failures and genuine capacity verdicts are made explicitly detectable and surface as a blocked result with the log line, never as a weakened gate. It resolves CR-001 (tier claim now present), CR-002 (diagnosis method, per-class fixes, full canonical validation list) and CR-003 (the portability rewrite covers the whole prologue, and the lost pipefail guarantee is compensated by the mandatory shape validation that follows the lowering pipeline).",
    "title": "Deploy Capacity Maintenance r2: classify run 38680893046, then make the SSH step's remote script POSIX-safe end-to-end and FETCH_HEAD-anchored (Tier 1)",
    "validation_commands": [
      {
        "cmd": "npx nx affected --target=test",
        "expected_exit": 0,
        "timeout_ms": 1800000
      },
      {
        "cmd": "npx nx affected --target=lint",
        "expected_exit": 0,
        "timeout_ms": 1800000
      },
      {
        "cmd": "npm run type-check",
        "expected_exit": 0,
        "timeout_ms": 1200000
      },
      {
        "cmd": "node tools/quality/quality.mjs format check-changed",
        "expected_exit": 0,
        "timeout_ms": 600000
      }
    ],
    "validation_plan": "Declared validation_commands are the four canonical suite entries and nothing else, as the plan contract requires. 'node tools/quality/quality.mjs format check-changed' is the gate that actually parses and formats the YAML edit \u2014 the omission CR-002 flagged in the r1 body; 'npx nx affected --target=lint', 'npx nx affected --target=test' and 'npm run type-check' are the always-run suite proving no collateral damage outside the single-file diff. Proof mapping: key-change-0 is proven by a diff confined to .github/workflows/deploy-capacity-maintenance.yml, a green suite, and a merged commit message that names the diagnosed class and the failing line; plan_contract:plan_architectural_tier_missing is proven by this envelope itself (architectural_tier 1 present; every validation command from the admissible set). Two confirmation actions sit outside the declared command set because they are operator dispatches, not sandbox commands: a post-merge workflow_dispatch with operation=report (exercises dispatch inputs, SSH transport, bare-store fetch, bootstrap and the report verb) and the next scheduled tick (exercises the empty-inputs fallback branch selecting safe-image-gc). The run-38680893046 step log is not among this request's admissible evidence refs, so the diagnosis step reads it during implementation; the class hypotheses themselves are grounded in the script text at the cited lines, which is admissible."
  },
  "request_id": "AIR-aria-primary-planner-12e4ce623d54",
  "role": "primary_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        ".github/workflows/deploy-capacity-maintenance.yml:59",
        ".github/workflows/deploy-capacity-maintenance.yml:54"
      ],
      "id": "key-change-0",
      "note": "The revision decomposes the r1 obligation (diagnose root cause + land architectural fix) into concrete steps that stay inside the single allowed file: kc-diagnose keeps id ci-run-38680893046-key-change-001 and classifies the failure from run 38680893046's step log; kc-prologue-posix, kc-guard-posix, kc-sha-fetchhead and kc-exit-classification land the architectural fix. The failing step is the workflow's only step (line 59) inside its only job (line 54), and its script block owns every code path between SSH connect and exit, so the diagnosis-and-fix arc is fully expressible within that one file.",
      "verdict": "satisfied"
    },
    {
      "evidence_refs": [
        ".github/workflows/deploy-capacity-maintenance.yml"
      ],
      "id": "plan_contract:plan_architectural_tier_missing",
      "note": "plan_content.architectural_tier is claimed as 1, scoped to the structural failure classes the rewrite removes: POSIX-only script syntax covering the whole prologue including the 'set -euo pipefail' line CR-003 flagged, and FETCH_HEAD-anchored SHA resolution. Every plan_content.validation_commands entry names one of the four canonical suite commands, now including 'node tools/quality/quality.mjs format check-changed' whose omission CR-002 flagged; no key change touches a TypeScript or JavaScript source file, so no imports declarations are due.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
