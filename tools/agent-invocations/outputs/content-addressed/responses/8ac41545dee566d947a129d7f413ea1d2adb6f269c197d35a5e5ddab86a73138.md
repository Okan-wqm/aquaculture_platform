{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-38052053551",
  "claim_id": "claim_070faac7229efb0d",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:bd533ad74bc9a9afbaeb8f0595cb782c8cbfc079742bb51010c70636497d8f24",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-primary-planner",
    "agent_text": "{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-primary-planner-94449778ac86\",\n  \"claim_id\": \"AIR-aria-primary-planner-94449778ac86\",\n  \"agent_id\": \"aria-primary-planner\",\n  \"role\": \"primary_plan\",\n  \"status\": \"submitted\",\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/plan-cyc-20261010T105259Z-auto/round-2-primary_plan-AIR-aria-primary-planner-94449778ac86.md\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"key_changes[0] of this revision keeps the obligation's id (ci-run-38038187180-key-change-001) and its single path (.github/workflows/database-wal-archive-freshness.yml), and it discharges both halves the obligation names. The diagnosis half is stated from the cited evidence: the observe step's remote payload honours the step's own three-outcome contract for the archive_mode question (an unreadable SHOW archive_mode falls to the '*' branch and prints dr_observed=indeterminate) but answers the RPO question with a two-outcome if/else, so an absent healthcheck script (exit 127), a non-executable one (exit 126) or docker refusing to exec is printed as rpo=breached, and the enforce step errors with PRODUCTION WAL ARCHIVE RPO BREACH for every token other than 'healthy', the empty token included. The architectural-fix half is prescribed as a named edit to named shell constructs rather than as an assignment restatement. No path outside the obligation's paths list is touched by any key change in this revision.\",\n      \"evidence_refs\": [\n        \".github/workflows/database-wal-archive-freshness.yml:55\",\n        \".github/workflows/database-wal-archive-freshness.yml\"\n      ]\n    },\n    {\n      \"id\": \"plan_contract:plan_architectural_tier_missing\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"plan_content.architectural_tier is now present and set to 1, with the claim justified against the cited file and narrowed to the behaviour it actually closes: after the edit, the token 'breached' has exactly one producer (a completed healthcheck execution with non-zero status that followed a successful runnability probe) and the enforce step is an exhaustive case whose breach arm matches only the literal string, so a probe that could not run, a capture that carried no marker, and a multi-valued marker can no longer reach the breach message at all. The residual class the closed mapping does not separate (a healthcheck present and executable that fails internally) is registered as risk R-5 with the enabling surface needed to close it, rather than claimed as covered. validation_commands carry only the four canonical spellings admissible under the Plan contract section of this request.\",\n      \"evidence_refs\": [\n        \".github/workflows/database-wal-archive-freshness.yml\",\n        \".github/workflows/database-wal-archive-freshness.yml:55\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \".github/workflows/database-wal-archive-freshness.yml:55\",\n    \".github/workflows/database-wal-archive-freshness.yml:16\",\n    \".github/workflows/database-wal-archive-freshness.yml\"\n  ],\n  \"plan_content\": {\n    \"schema_version\": 2,\n    \"architectural_tier\": 1,\n    \"title\": \"Close the WAL-freshness lane's cannot-tell gap in both places it leaks: the RPO verdict and the observe step's own failure surface\",\n    \"summary\": \"The 'Database WAL Archive Freshness' lane states a three-outcome contract in its own payload comment \u2014 verdict, counter-verdict, cannot-tell, with cannot-tell failing closed instead of guessing \u2014 and keeps it for the archive_mode question while breaking it for the RPO question. The remote payload maps every non-zero docker exec result of the in-container healthcheck to rpo=breached (exit 127 for an absent script included), the runner-side marker extraction can yield an empty or multi-valued rpo, and the enforce step turns any non-healthy token into a PRODUCTION WAL ARCHIVE RPO BREACH;...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 110895,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 110895,
      "cache_read_input_tokens": 0,
      "inference_geo": "global",
      "input_tokens": 2,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 110895,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 110895,
          "cache_read_input_tokens": 0,
          "input_tokens": 2,
          "output_tokens": 36128,
          "type": "message"
        }
      ],
      "output_tokens": 36128,
      "output_tokens_details": {
        "thinking_tokens": 22604
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "revision": {
      "addresses_review_risk_ids": [
        "CR-001",
        "CR-002",
        "CR-003",
        "CR-004",
        "CR-005",
        "CR-006"
      ],
      "evidence_basis": "The hash-anchored excerpts in this request cover .github/workflows/database-wal-archive-freshness.yml lines 1-162, which is the whole file, and were sufficient; no file read beyond them was needed and no other source was consulted. No run-id or coverage-manifest reference is cited anywhere in this envelope: the only reference form this plan cites is the repo-relative path form present in the request's evidence payload.",
      "resolutions": {
        "CR-001": "plan_content.architectural_tier is now present and set to 1, justified against the cited file and narrowed to the class it closes. The challenger's tier-1 formulation is adopted, with the narrowing CR-005 asked for.",
        "CR-002": "The vacuous key change is replaced by five prescribed edits to named shell constructs in the one allowed file, each with its diagnosis, plus a risk register and a concrete revert command.",
        "CR-003": "Reconciled rather than restated: the observe step's own failure modes (non-zero run-protected-ssh.sh, the 120-second command budget, an empty capture, an unrecognised observation, cleanup) are enumerated in the context and recursive-impact sections and handled in key change 003 by giving each class its own error label; key change 002 closes a second false-breach route the challenger did not reach (multi-line marker extraction); risk R-2 restates the keep-red scenario with the correct step attribution; and plan step 9 requires the delivery record to state that the admissible file evidence cannot prove which observe-step failure mode produced the named failing step.",
        "CR-004": "Carried into the plan in substance: risk R-1 and plan step 8 require the implementer to refuse with enabling_surfaces naming tests/invariants/wal-archive-activation.spec.ts, and forbid editing, skipping or suppressing that spec and forbid weakening the closed mapping to force green.",
        "CR-005": "The tier-1 justification is explicitly narrowed to the cannot-tell-as-verdict class; the residual healthcheck-internal-failure class is registered as risk R-5, made detectable by carrying the healthcheck exit status into the failure text, and its enabling surfaces are named rather than claimed closed.",
        "CR-006": "affected_surfaces is emitted in the canonical [{paths: [...]}] shape, so the body is valid against the strict kernel validator without relying on the adapter-boundary normalizer."
      }
    },
    "runtime_attempt_ledger_hash": "sha256:96437043b02398f3be5082179f666821b70bc667d49897492fe47fae21e37643"
  },
  "evidence_refs": [
    ".github/workflows/database-wal-archive-freshness.yml:55",
    ".github/workflows/database-wal-archive-freshness.yml:16",
    ".github/workflows/database-wal-archive-freshness.yml"
  ],
  "plan_content": {
    "affected_surfaces": [
      {
        "paths": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ]
      }
    ],
    "architectural_approach": "Tier 1 \u2014 make the wrong behaviour structurally unreachable, not merely visible. The wrong behaviour is a cannot-tell published as a verdict, and today it is reachable through three open mappings: the payload's two-arm if/else treats 'could not run' as 'ran and failed'; the runner-side extraction can hand a multi-valued or empty token to a consumer that only tests inequality against 'healthy'; and the enforce step's inequality test treats 'no answer' as 'breached'. After the change all three are closed. The payload first probes that the healthcheck is runnable in the container and emits rpo=indeterminate when it is not, so only a completed execution's exit status can produce healthy or breached. The extraction takes a single last-match value per marker key, so a capture holding the healthcheck's own output or repeated markers cannot produce a multi-line token. The enforce step is an exhaustive case in which the breach arm matches exactly the string 'breached' and the default arm fails closed under its own cannot-tell label. There is no remaining code path on which docker refusing to exec (127), a non-executable script (126), a truncated capture, or an absent marker reaches the breach message \u2014 the runtime structure prevents the misclassification, mirroring the closed case the same file already implements for archive_mode. The same tier applies to the observe step's own failure surface: each of its distinguishable failure classes gains its own label, and every branch still exits non-zero, so a lane that cannot read production fails closed under a name instead of under a guess. The tier-1 claim is deliberately narrowed: it covers the cannot-tell-as-verdict class. A healthcheck that is present, executable, and fails for its own internal reason still completes with a non-zero status and is still labelled breached; separating that from a genuine budget breach needs the healthcheck script's own exit-status contract, which is neither in the admissible evidence nor inside allowed_scope. This plan makes that residual class detectable rather than silent \u2014 the captured exit status travels into the failure text as rpo_rc so an operator can tell the two apart \u2014 and registers the structural closure as risk R-5 with its enabling surface, instead of claiming coverage it cannot prove.",
    "architectural_tier": 1,
    "context": "What the lane does, in one pass: every five minutes (cron '*/5 * * * *', job 'verify' gated to refs/heads/main) it asserts the protected backup secret set, SSHes to the production droplet through tools/scripts/ci/run-protected-ssh.sh with a 120-second command budget, and asks PostgreSQL two questions inside the aqua-postgres container \u2014 is archive_mode on, and is the WAL-G healthcheck inside its five-minute RPO budget \u2014 then converts the two answers into green or red. Why the distinction being fixed matters: the step's own comment states the design rule, that a probe returns one of three outcomes (verdict, counter-verdict, cannot-tell) because a monitor that cannot tell 'broken' from 'blind' sends operators to fight the wrong fire, and that cannot-tell must fail closed rather than guess. The file keeps that rule for archive_mode and breaks it for the healthcheck: a non-zero docker exec \u2014 including exit 127 when /usr/local/bin/postgres-walg-healthcheck.sh is absent from the container, exactly the opaque-127 class the comment says this design exists to eliminate \u2014 is printed as rpo=breached, and the enforce step reports a production data-protection incident for it, and for an empty rpo token, and for a multi-valued one. What breaks if this is skipped: a container that lost its healthcheck script, a docker daemon refusing exec, or a truncated capture is published as a production WAL archive breach; CI stays red under a false label while the real fault stays undiagnosed, and every genuine breach alert afterwards inherits doubt. The second half of the work exists because of the failing signature itself: the signature names 'verify::Observe production WAL archive runtime', and under the current code the healthcheck leg cannot fail that step (its if/else exits 0 in both arms), so whatever went red there is one of the observe step's own failure modes \u2014 a non-zero run-protected-ssh.sh, the 120-second timeout, an empty or unrecognisable capture tripping the single generic guard, or a cleanup-trap failure \u2014 and today those classes are indistinguishable in the log. Fixing only the RPO taxonomy would leave the step that actually failed still unable to say why, which is the same defect in a second location. Downstream surfaces: the enforce step in the same file (the rpo consumer), tools/scripts/database/resolve-dr-activation.sh (the DR_OBSERVED consumer, whose vocabulary this plan leaves byte-identical), tests/invariants/wal-archive-activation.spec.ts (which the step's comment says runs this payload), and the operators and alert routes that read the error strings. What evidence proves the result: the payload's emitted RPO vocabulary becomes the closed set {healthy, breached, indeterminate} with 'breached' reachable only after a completed execution, each observe-step failure class gets its own error label, and the canonical suite stays green \u2014 in particular 'npx nx affected --target=test', which exercises the payload through the invariant spec the file names.",
    "coverage": {
      "waivers": []
    },
    "evidence_refs": [
      ".github/workflows/database-wal-archive-freshness.yml:55",
      ".github/workflows/database-wal-archive-freshness.yml:16",
      ".github/workflows/database-wal-archive-freshness.yml"
    ],
    "failing_signature": {
      "failed": [
        "verify::Observe production WAL archive runtime"
      ],
      "workflow_path": ".github/workflows/database-wal-archive-freshness.yml"
    },
    "key_changes": [
      {
        "description": "Diagnose the failing lane and fix the RPO leg of the remote payload inside the 'Observe production WAL archive runtime' step (.github/workflows/database-wal-archive-freshness.yml:55). Diagnosis, from the hash-anchored excerpt in this request only: the payload honours the step's stated three-outcome contract for the archive_mode question (an unreadable SHOW archive_mode falls to the '*' branch and prints dr_observed=indeterminate, then exits 0) but answers the RPO question with a two-arm if/else \u2014 if docker exec aqua-postgres /usr/local/bin/postgres-walg-healthcheck.sh succeeds print rpo=healthy, else print rpo=breached \u2014 so an absent script (exit 127), a non-executable script (exit 126), or docker refusing to exec is recorded as a breach verdict; the enforce step then errors with PRODUCTION WAL ARCHIVE RPO BREACH for every token other than 'healthy', the empty token included. Edit, inside the AQUA_REMOTE_SCRIPT heredoc: replace that if/else with a closed mapping. (a) Probe runnability first with 'docker exec aqua-postgres test -x /usr/local/bin/postgres-walg-healthcheck.sh' with stderr discarded; a failed probe prints the single line rpo=indeterminate, then the line rpo_rc=unrunnable, then exits 0. (b) On a successful probe, run the healthcheck with its stdout and stderr left in the capture stream (the breach message points operators at that diagnosis, so it must stay visible), collect its status without tripping set -e by initialising a status variable to 0 and appending '|| status=$?' to the docker exec, print rpo=healthy when the status is 0 and rpo=breached otherwise, and print rpo_rc with the numeric status as the last marker line the payload emits. Leave the dr_observed leg, its present/absent/indeterminate vocabulary, its printf spelling and its early exits byte-identical, and leave the step's SSH hygiene untouched (mktemp -d, umask 077, the cleanup trap and its status arithmetic, and the /usr/bin/env -i invocation of tools/scripts/ci/run-protected-ssh.sh with its exported variable set).",
        "id": "ci-run-38038187180-key-change-001",
        "imports": [],
        "paths": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ]
      },
      {
        "description": "Make the runner-side marker extraction in the same observe step single-valued and deterministic (.github/workflows/database-wal-archive-freshness.yml:55). Today both extractions use awk with a print in the match body, which emits one line per matching line, so a capture that holds more than one line parsing to the same key hands the shell a multi-line value; the enforce step's inequality test against 'healthy' then reads that as non-healthy and reports a breach \u2014 a second route to the same false verdict. Edit: change each extraction to assign in the match body and print once in END, i.e. awk -F= '$1 == \"dr_observed\" { value = $2 } END { print value }' and awk -F= '$1 == \"rpo\" { value = $2 } END { print value }', and add the same form for the new key, awk -F= '$1 == \"rpo_rc\" { value = $2 } END { print value }'. Because the payload emits its rpo and rpo_rc markers as the last lines it prints, last-match extraction cannot be displaced by the healthcheck's own output; a line from the healthcheck that parses as a dr_observed marker yields a token outside the closed vocabulary and is caught by the labelled guard added in key change 003 rather than silently accepted.",
        "id": "ci-run-38038187180-key-change-002",
        "imports": [],
        "paths": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ]
      },
      {
        "description": "Give the observe step's own failure classes distinct labels, because that step \u2014 not the enforce step \u2014 is the one the failing signature names, and today its classes are indistinguishable in the log (.github/workflows/database-wal-archive-freshness.yml:55). Edit, three parts, all inside that step. (a) Transport class: wrap the /usr/bin/env -i ... bash tools/scripts/ci/run-protected-ssh.sh invocation in an if-not block so a non-zero exit emits one distinct error line naming the class (SSH transport, authentication, or the 120-second SSH_COMMAND_TIMEOUT_SECONDS budget), states that this is a cannot-tell about production rather than a verdict about the archiver, and then exits 1 so the cleanup trap still runs; placing the command in an if condition leaves set -e semantics intact for every other line, and the argv and exported variable set stay identical. (b) Capture classes: split the single '::error::The production probe returned no recognisable observation.' guard into two labelled branches \u2014 an empty capture (no marker line at all, which means the transport truncated or the payload died before printing) and a non-empty capture carrying a token outside the closed dr_observed vocabulary (payload vocabulary drift), the second printing the bounded offending token in quotes so the operator sees what arrived; print only that token, never the capture file wholesale, so the step keeps its secret hygiene. Both branches exit 1, so the lane still fails closed. (c) Emit rpo_rc to GITHUB_OUTPUT alongside observed and rpo, using the same printf form already used there.",
        "id": "ci-run-38038187180-key-change-003",
        "imports": [],
        "paths": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ]
      },
      {
        "description": "Convert the 'Enforce the five-minute RPO' step from an open inequality test to a closed case mapping (.github/workflows/database-wal-archive-freshness.yml). Today the step runs 'if [ \"${RPO}\" != healthy ]' and emits the breach error for everything else, so an empty, indeterminate or multi-valued token is published as a production data-protection incident. Edit: declare RPO_RC: ${{ steps.observe.outputs.rpo_rc }} in the step's env next to the existing RPO declaration \u2014 this is load-bearing, because the step runs under set -u and an undeclared variable would abort it on an unbound reference \u2014 and replace the if with an exhaustive case on RPO. The 'healthy' arm prints the existing success line unchanged. The 'breached' arm keeps the existing breach sentence verbatim as its leading text (so any routing or runbook keyed on that sentence keeps its anchor) and appends one further sentence carrying the captured healthcheck exit status from RPO_RC, then exits 1. The default arm is the cannot-tell branch: it emits a new, distinct error line stating that the lane could not obtain an RPO verdict, naming the three causes the payload can now distinguish (healthcheck not runnable in aqua-postgres, docker exec refused, or an observation capture carrying no rpo marker), quoting the received token and RPO_RC, and stating that this is a cannot-tell rather than a breach so triage goes to the probe and not to the archiver; it exits 1, keeping the lane fail-closed. Control flow branches on RPO alone, whose producer vocabulary is now the closed set {healthy, breached, indeterminate}; RPO_RC is interpolated into message text only and is never tested, so it cannot widen the control-flow surface. Keep the step's 'if: steps.activation.outputs.dr_verdict == active' gating unchanged.",
        "id": "ci-run-38038187180-key-change-004",
        "imports": [],
        "paths": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ]
      },
      {
        "description": "Update the comment block above the observe step so the stated contract matches the code it documents (.github/workflows/database-wal-archive-freshness.yml:55). The present comment states the three-outcome rule and the fail-closed consequence for the archive_mode question only. Edit: extend it to state that both questions the lane asks now return one of three outcomes, that the RPO question's cannot-tell outcome is rpo=indeterminate and is produced when the healthcheck is not runnable in the container, that rpo_rc carries the healthcheck's exit status (or the literal unrunnable) for the failure text only, and that the observe step labels its own failure classes (transport or timeout, empty capture, unrecognised observation) separately because a monitor that cannot read production must say so under its own name. Keep the existing INFRA-CRITICAL-195 note and the line naming tests/invariants/wal-archive-activation.spec.ts intact. No other comment, step, trigger, permission, environment or concurrency setting changes, and no file other than this workflow is touched by any key change in this plan.",
        "id": "ci-run-38038187180-key-change-005",
        "imports": [],
        "paths": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ]
      }
    ],
    "plan_steps_detailed": [
      "1. Ground the diagnosis in the cited evidence before editing. The hash-anchored excerpt of .github/workflows/database-wal-archive-freshness.yml covering the whole file is sufficient and was not supplemented by any other source; run logs are not admissible in this envelope and no run-id reference is cited anywhere in it. From that excerpt: the archive_mode question is a closed case with three outcomes; the RPO question is a two-arm if/else; the runner-side extraction prints one line per match; the enforce step tests inequality against 'healthy'. Those four facts are the root cause this plan closes. (must_satisfy: key-change-0; evidence: .github/workflows/database-wal-archive-freshness.yml:55 and the file.)",
      "2. Apply key change 001 to the AQUA_REMOTE_SCRIPT heredoc inside the observe step: runnability probe, then exit-status mapping, then the rpo and rpo_rc marker lines last. Do not touch the dr_observed leg, the SSH hygiene, or the /usr/bin/env -i argv. (must_satisfy: key-change-0; evidence: .github/workflows/database-wal-archive-freshness.yml:55.)",
      "3. Apply key change 002 to the two awk extractions in the same step and add the third for rpo_rc, each assigning in the match body and printing once in END. (must_satisfy: key-change-0; evidence: .github/workflows/database-wal-archive-freshness.yml:55.)",
      "4. Apply key change 003 to the same step: the if-not wrapper around run-protected-ssh.sh with its own labelled error and exit 1; the split of the single unrecognisable-observation guard into an empty-capture branch and an unrecognised-token branch, each labelled and each exiting 1; and the rpo_rc line appended to GITHUB_OUTPUT. (must_satisfy: key-change-0; evidence: .github/workflows/database-wal-archive-freshness.yml:55.)",
      "5. Apply key change 004 to the 'Enforce the five-minute RPO' step: add RPO_RC to the step env, replace the inequality test with the exhaustive case, preserve the breach sentence verbatim as leading text, and add the cannot-tell default arm. Leave the dr_verdict gating as it is. (must_satisfy: key-change-0; evidence: .github/workflows/database-wal-archive-freshness.yml.)",
      "6. Apply key change 005 to the comment block so the documented contract covers both questions and the observe step's labelled failure classes. (must_satisfy: key-change-0; evidence: .github/workflows/database-wal-archive-freshness.yml:55.)",
      "7. Confirm the job-level guardrails at .github/workflows/database-wal-archive-freshness.yml:16 are unchanged by the diff: the verify job condition, the protected-main assertion, environment production-backup, the concurrency group, and permissions contents: read. The lane must remain read-only over production. (must_satisfy: key-change-0; evidence: .github/workflows/database-wal-archive-freshness.yml:16.)",
      "8. Run the four declared validation commands. If 'npx nx affected --target=test' fails because tests/invariants/wal-archive-activation.spec.ts pins the two-value rpo vocabulary, stop: that file is not inside allowed_scope, so surface it as an enabling surface in a refusal envelope and let the operator widen scope. Do not edit the spec, do not skip or suppress it, and do not weaken the closed mapping to make the suite green. (must_satisfy: key-change-0; evidence: .github/workflows/database-wal-archive-freshness.yml:55.)",
      "9. In the delivery record, state the causal position of this work explicitly: the failing signature names the observe step, and under the pre-edit code the healthcheck leg could not fail that step because its if/else exited 0 in both arms, so the triggering fault is one of the observe step's own failure modes. The admissible file evidence cannot say which one. Step 4 makes each of them self-identifying on the next scheduled run, and steps 2-5 close the false-breach class the same file's own contract already forbids; neither claim is presented as proof about the triggering run. (must_satisfy: key-change-0; evidence: .github/workflows/database-wal-archive-freshness.yml and .github/workflows/database-wal-archive-freshness.yml:55.)"
    ],
    "recursive_impact": "This envelope carries zero impact_graph_refs entries, so no entry with status unknown blocks dispatch; the trace below is derived from the cited evidence alone and is marked accordingly. (1) 'Enforce the five-minute RPO' step, same file, relationship: consumer of steps.observe.outputs.rpo and of the new rpo_rc output \u2014 status known (cited evidence), containing validation: the canonical suite plus grep-level structural inspection of the one changed file; addressed by key change 004. (2) tools/scripts/database/resolve-dr-activation.sh, relationship: consumer of DR_OBSERVED with the present/absent/indeterminate vocabulary \u2014 status known by reference from the cited evidence; this plan leaves the dr_observed printf and its vocabulary byte-identical, so no drift crosses that boundary. (3) tests/invariants/wal-archive-activation.spec.ts, relationship: executes the embedded remote payload, as stated in the observe step's own comment inside the cited evidence \u2014 status known by reference, assertions NOT present in the admissible evidence and the file NOT inside allowed_scope; containing validation: 'npx nx affected --target=test'; this is the most extreme affected node the trace reaches, because a vocabulary extension in the payload surfaces as an assertion change there and nowhere further; escalation path is risk R-1 (the implementer refuses with enabling_surfaces naming the spec, never editing it and never weakening the mapping to force green). (4) tools/scripts/ci/run-protected-ssh.sh, relationship: invoked with an unchanged /usr/bin/env -i argv and an unchanged exported variable set \u2014 status known; only the workflow's handling of its non-zero exit changes, inside the workflow. (5) tools/scripts/database/assert-backup-secrets.sh, relationship: untouched preflight \u2014 status known. (6) Human and alert-routing consumers of the error strings, relationship: text consumers \u2014 status known; the existing breach sentence is preserved verbatim as the leading text of the breach message and two new distinct labels are added. (7) Job-level guardrails at .github/workflows/database-wal-archive-freshness.yml:16 (the verify job, the refs/heads/main condition, the protected-main assertion, environment production-backup, concurrency group database-wal-archive-freshness-v2 with cancel-in-progress false, permissions contents: read) \u2014 untouched; the lane stays read-only over production, the remote payload only observes, so the transitive trace terminates at operator triage behaviour and at the invariant spec rather than at any production mutation.",
    "risks": [
      {
        "affected_files": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ],
        "evidence_refs": [
          ".github/workflows/database-wal-archive-freshness.yml:55",
          ".github/workflows/database-wal-archive-freshness.yml"
        ],
        "required_plan_changes": "None to this plan. The implementer must, on such a failure, emit a refusal envelope whose enabling_surfaces names tests/invariants/wal-archive-activation.spec.ts so the operator widens scope. Editing the spec, skipping or suppressing it, or weakening the closed mapping to force green are all forbidden by this plan.",
        "risk_id": "R-1",
        "severity": "HIGH",
        "summary": "tests/invariants/wal-archive-activation.spec.ts executes the edited payload (the observe step's own comment says so), and if its assertions pin the two-value rpo vocabulary, extending that vocabulary to three values turns the suite red \u2014 and that spec file is not inside allowed_scope."
      },
      {
        "affected_files": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ],
        "evidence_refs": [
          ".github/workflows/database-wal-archive-freshness.yml",
          ".github/workflows/database-wal-archive-freshness.yml:55"
        ],
        "required_plan_changes": "Already folded in: key change 003 labels each observe-step failure class, and plan step 9 requires the delivery record to state that the admissible file evidence cannot prove which of those classes produced the named failing step. A true breach, or a true transport fault, requires production-side remediation that this lane only observes and never performs.",
        "risk_id": "R-2",
        "severity": "MEDIUM",
        "summary": "This plan guarantees honest labels, not a green run, and the step attribution matters for triage: a genuine completed-run healthcheck failure fails the 'Enforce the five-minute RPO' step, while a transport, timeout or capture failure fails the 'Observe production WAL archive runtime' step \u2014 which is the step the failing signature names. Under the pre-edit code the healthcheck leg could not fail the observe step at all, because its if/else exited 0 in both arms."
      },
      {
        "affected_files": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ],
        "evidence_refs": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ],
        "required_plan_changes": "Already folded in: key change 004 preserves the breach sentence verbatim as leading text so prefix and substring anchors keep matching, and gives the cannot-tell outcomes wording that cannot be confused with a breach. A consumer matching the breach line in full would need its matcher relaxed to a prefix; this is stated in the delivery record.",
        "risk_id": "R-3",
        "severity": "LOW",
        "summary": "Message-text consumers (alert routing, runbooks keyed on the existing PRODUCTION WAL ARCHIVE RPO BREACH sentence) see that sentence preserved as the leading text with one exit-status sentence appended, plus two new distinct error messages they have never matched before."
      },
      {
        "affected_files": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ],
        "evidence_refs": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ],
        "required_plan_changes": "None. The probe is a container-local test builtin; if it cannot complete, the closed mapping absorbs the outcome as rpo=indeterminate and the lane fails closed under its own label, and a timeout of the SSH command itself now emits the labelled transport error from key change 003 rather than an unlabelled step failure.",
        "risk_id": "R-4",
        "severity": "LOW",
        "summary": "The runnability probe adds one extra docker exec per five-minute run inside the step's 120-second SSH command budget."
      },
      {
        "affected_files": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ],
        "evidence_refs": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ],
        "required_plan_changes": "Already folded in at the detectable level: key changes 001, 003 and 004 carry the healthcheck's exit status through rpo_rc into the failure text so an operator can separate an internal fault from a budget breach. Closing it structurally needs the exit-status contract of /usr/local/bin/postgres-walg-healthcheck.sh, which is neither in this envelope's admissible evidence nor inside allowed_scope; that script and its owning image definition are the enabling surfaces a follow-on envelope must name, with an operator-assigned owner and date, before any exit-status partition is prescribed. This plan prescribes no mapping it cannot evidence.",
        "risk_id": "R-5",
        "severity": "MEDIUM",
        "summary": "Residual mislabel class the closed mapping does not separate: a healthcheck that is present and executable but fails for its own internal reason (missing environment, its own defect) completes with a non-zero exit and is still labelled breached. The tier-1 claim in this plan covers the cannot-tell-as-verdict class, not healthcheck-internal failures."
      },
      {
        "affected_files": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ],
        "evidence_refs": [
          ".github/workflows/database-wal-archive-freshness.yml"
        ],
        "required_plan_changes": "Already folded in: key change 004 declares RPO_RC in the step env alongside RPO, so the variable is always defined (empty when the output is absent) and the default case arm handles an empty value as a cannot-tell.",
        "risk_id": "R-6",
        "severity": "LOW",
        "summary": "The enforce step runs under set -u, so referencing RPO_RC without declaring it in that step's env would abort the step on an unbound variable \u2014 a careless application of key change 004 would turn a correctness fix into a new red lane."
      }
    ],
    "rollback": "One file, one commit, no external state to unwind: the job holds permissions contents: read and the remote payload only observes the droplet, so reverting changes nothing in production. Revert with 'git revert <commit-sha>' for the single commit that carries this change (equivalently 'git checkout <parent-sha> -- .github/workflows/database-wal-archive-freshness.yml' followed by a commit, on the active branch, with no force push). A revert reinstates the exact behaviour this plan removes \u2014 a healthcheck that could not run, a truncated capture, and a multi-valued marker all reported as PRODUCTION WAL ARCHIVE RPO BREACH, and the observe step's transport, truncation and vocabulary failures collapsed into one unlabelled failure \u2014 so any rollback must be paired with an operator-visible statement of that regression. Because the monitor is scheduled every five minutes under concurrency group database-wal-archive-freshness-v2 with cancel-in-progress false, the reverted behaviour is observable on the next run with no deployment action.",
    "schema_version": 2,
    "summary": "The 'Database WAL Archive Freshness' lane states a three-outcome contract in its own payload comment \u2014 verdict, counter-verdict, cannot-tell, with cannot-tell failing closed instead of guessing \u2014 and keeps it for the archive_mode question while breaking it for the RPO question. The remote payload maps every non-zero docker exec result of the in-container healthcheck to rpo=breached (exit 127 for an absent script included), the runner-side marker extraction can yield an empty or multi-valued rpo, and the enforce step turns any non-healthy token into a PRODUCTION WAL ARCHIVE RPO BREACH; separately, the observe step that the failing signature actually names collapses its transport, truncation and vocabulary-drift failures into one unlabeled or generic failure. This revision lands both halves inside the single workflow file: a runnability probe plus exit-code mapping that makes rpo a closed three-value token, deterministic last-match marker extraction, an exhaustive case in the enforce step whose breach arm matches only the literal 'breached', and one distinct error label per observe-step failure class. The existing breach sentence is preserved as the leading text of the breach message and the dr_observed leg stays byte-identical, so resolve-dr-activation.sh and any alert routing keyed on that sentence see no vocabulary drift. The plan states plainly that the admissible file evidence cannot prove which observe-step failure mode produced the named failing step; it makes each one self-identifying on the next scheduled run instead of guessing which it was.",
    "title": "Close the WAL-freshness lane's cannot-tell gap in both places it leaks: the RPO verdict and the observe step's own failure surface",
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
    "validation_plan": "Four commands, all canonical spellings from the admissible set in this request's Plan contract block, each expected to exit 0. (1) 'npx nx affected --target=test' is the load-bearing check: the observe step's own comment states that tests/invariants/wal-archive-activation.spec.ts runs this payload, so a regression in the payload's emitted vocabulary surfaces here; green proves the dr_observed leg is unchanged in the way the spec asserts and that the third rpo token does not break it. A failure here on the new token is the escalation path in risk R-1, not a licence to edit the spec. (2) 'npx nx affected --target=lint' proves no lint target regresses on the changed surface. (3) 'npm run type-check' proves the TypeScript invariant spec that executes this payload still compiles. (4) 'node tools/quality/quality.mjs format check-changed' gates the formatting of the only changed file, the workflow YAML. Beyond the suite, three structural checks on that one file prove the fix itself, each a grep-level inspection: the token 'breached' has exactly one producer, on a path that follows a successful runnability probe and a completed healthcheck with non-zero status; the enforce step contains an exhaustive case whose breach arm matches the literal 'breached' and whose default arm emits the cannot-tell label and exits non-zero; and the observe step emits one distinct error line per failure class (transport or timeout, empty capture, unrecognised observation). Mapping to the obligations: key-change-0 is proven by the diff touching only .github/workflows/database-wal-archive-freshness.yml and by key change 001 being applied as written, which the three structural checks above read back out of the file; plan_contract:plan_architectural_tier_missing is proven at the kernel's plan-contract gate rather than by a shell command \u2014 this body carries architectural_tier 1 and only admissible validation commands, which is what that gate reads. After the change the lane's next scheduled run reports one of exactly four things: a healthy pass, a true breach with the healthcheck's exit status named, a cannot-tell about the RPO under its own label, or a cannot-tell about the probe itself under the observe step's own label \u2014 and never a false breach."
  },
  "request_id": "AIR-aria-primary-planner-94449778ac86",
  "role": "primary_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        ".github/workflows/database-wal-archive-freshness.yml:55",
        ".github/workflows/database-wal-archive-freshness.yml"
      ],
      "id": "key-change-0",
      "note": "key_changes[0] of this revision keeps the obligation's id (ci-run-38038187180-key-change-001) and its single path (.github/workflows/database-wal-archive-freshness.yml), and it discharges both halves the obligation names. The diagnosis half is stated from the cited evidence: the observe step's remote payload honours the step's own three-outcome contract for the archive_mode question (an unreadable SHOW archive_mode falls to the '*' branch and prints dr_observed=indeterminate) but answers the RPO question with a two-outcome if/else, so an absent healthcheck script (exit 127), a non-executable one (exit 126) or docker refusing to exec is printed as rpo=breached, and the enforce step errors with PRODUCTION WAL ARCHIVE RPO BREACH for every token other than 'healthy', the empty token included. The architectural-fix half is prescribed as a named edit to named shell constructs rather than as an assignment restatement. No path outside the obligation's paths list is touched by any key change in this revision.",
      "verdict": "satisfied"
    },
    {
      "evidence_refs": [
        ".github/workflows/database-wal-archive-freshness.yml",
        ".github/workflows/database-wal-archive-freshness.yml:55"
      ],
      "id": "plan_contract:plan_architectural_tier_missing",
      "note": "plan_content.architectural_tier is now present and set to 1, with the claim justified against the cited file and narrowed to the behaviour it actually closes: after the edit, the token 'breached' has exactly one producer (a completed healthcheck execution with non-zero status that followed a successful runnability probe) and the enforce step is an exhaustive case whose breach arm matches only the literal string, so a probe that could not run, a capture that carried no marker, and a multi-valued marker can no longer reach the breach message at all. The residual class the closed mapping does not separate (a healthcheck present and executable that fails internally) is registered as risk R-5 with the enabling surface needed to close it, rather than claimed as covered. validation_commands carry only the four canonical spellings admissible under the Plan contract section of this request.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
