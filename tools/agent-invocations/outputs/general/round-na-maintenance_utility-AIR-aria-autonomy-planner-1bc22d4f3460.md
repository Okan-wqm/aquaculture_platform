{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-32167129769",
  "claim_id": "claim_9b9a2b37bc23bae4",
  "details": {
    "agent_subagent_type": "aria-autonomy-planner",
    "agent_text": "**Queue item `qi-8b671726dc6f` resolved: satisfied, not blocked.** The response envelope is validated (parseable `aria/agent-response/v1`, 46 evidence refs, zero banned-phrase hits) and written to the expected output path.\n\nWhat I found, in short: the pressure's recommended action \u2014 \"sample and judge increased SHADOW findings before calibration\" \u2014 is already half-executed by the kernel itself. Sampling is automatic (6 judgment samples, 30 findings, minted every cycle since the source cycle) and 80 evidence/adversarial judge envelopes for this adapter are already minted \u2014 but **zero** have outputs and **zero** operator verdicts exist, which is why every calibrated weight in every pressure record still sits at its untouched prior (tp=0, fp=0). The +1 delta decomposes into exactly one content-new finding (a doc referencing the absent `apps/hr-service/schema.graphql`) plus ~40 line-shift re-mints from ARIA's own living ledger `docs/reviews/orphan-findings.md`. The plan: drain the existing judge envelopes (or clear the operator worklist via the embedded CLI), fold verdicts through consensus into both calibrations, then evaluate SHADOW\u2192ACTIVE through the single readiness gate. Three structural defects travel with queue candidates: living-ledger line churn, the minted-but-undrained judge backlog, and duplicate planner envelopes for one cause (sibling request `AIR-aria-autonomy-planner-e7f928f5e249` should be marked superseded).\n\n```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-autonomy-planner-1bc22d4f3460\",\n  \"claim_id\": \"claim_pending-lease-injection\",\n  \"agent_id\": \"aria-autonomy-planner\",\n  \"role\": \"maintenance_utility\",\n  \"status\": \"submitted\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"queue_item_projected\",\n      \"verdict\": \"satisfied\",\n      \"evidence\": \"Resolved queue item qi-8b671726dc6f (pressure pressure:shadow-raw-delta:doc-staleness-adapter, source cycle cyc-20260816T182612Z-auto, recommended action 'sample and judge increased SHADOW findings before calibration') into the concrete queue plan in details.queue_plan. The pressure's subject is real and its remedy is reachable on stable kernel surfaces. Subject: the doc-staleness adapter runs in SHADOW, a runner-required status (aria-kernel/aria_kernel/tool_registry.py:38), and its source-cycle run raised the raw finding count 1147 to 1148 (+1, matching the pressure reason), with the next cycle at +3 - counts read from the runs and raw-findings ledgers (runtime rows, prose grade). The request's twenty evidence_refs all resolve at the workspace; they are the adapter run's declared read surface over docs/**, which is what the mint site attaches as pressure evidence, not the delta findings themselves - the delta findings live in the raw-findings ledger. Remedy reachability, proven per step: sampling is already automatic (generate_judgment_sample at aria-kernel/aria_kernel/feedback_store.py:550 minted six per-cycle samples for this tool, thirty findings, every one status pending); judging has two live lanes - eighty evidence/adversarial judge envelopes for this adapter's findings are minted and idempotent but have zero outputs, and the operator batch lane is printed inside each sample row (feedback_store.py:582, record at feedback_store.py:201, batch at feedback_store.py:259, closed verdict vocabulary at feedback_store.py:17); consensus needs two unique judges (feedback_store.py:377) with disagreement parked as uncertainty (feedback_store.py:448); verdicts then feed source-weight calibration tp/fp buckets (aria-kernel/aria_kernel/calibration.py:76 through calibration.py:87) and adapter precision history (aria-kernel/aria_kernel/adapter_calibration.py:34, adapter_calibration.py:117), which is the only exit from the operator_precision_unjudged readiness blocker (aria-kernel/aria_kernel/readiness.py:37, readiness.py:78; accepted statuses readiness.py:13) toward SHADOW to ACTIVE strictly through promote_tool (aria-kernel/aria_kernel/promotion.py:11; auto...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 133976,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 133976,
      "cache_read_input_tokens": 1453296,
      "inference_geo": "not_available",
      "input_tokens": 214,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 766,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 766,
          "cache_read_input_tokens": 152461,
          "input_tokens": 2,
          "output_tokens": 11464,
          "type": "message"
        }
      ],
      "output_tokens": 67914,
      "output_tokens_details": {
        "thinking_tokens": 33257
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "evidence_admissibility_note": "Formal citations are limited to the request's twenty evidence_refs (all resolve in the workspace) plus allowed-scope files verified blob-identical between the request's target_sha 82852e31fb8d09c84bc04cc7e9904d75b334ca59 and the working tree (verified: next_cycle_queue.py, adapter_calibration.py, readiness.py, tool_registry.py, promotion.py, feedback_store.py, calibration.py, the planner contract, the layer-2 envelope SSoT). Named in prose only because they fail one of those two tests: pressure.py, cycle.py, judge_fanout.py, agent_invocations.py, autonomy_orchestrator.py (worktree blobs drifted from target_sha after the ORPHAN-723 merge landed as 4f2931d38); tools/aria-adapters/doc-staleness-adapter.{ts,tool.json,test.ts} (outside the allowed_scope-plus-request-refs bounding box); every state-store row (registry.json, runs.jsonl, raw-findings.jsonl, judgment-samples.jsonl, operator-feedback.jsonl, queues/next_cycle_queue.jsonl, agent-invocations/requests.jsonl - runtime artifacts, not repo files); docs/reviews/**, docs/db/**, docs/adr/**, docs/plans/**, docs/research/**, docs/runbooks/**, docs/security/** paths that appear inside finding ids; and every absent-path verification (an absent file cannot carry a file:line citation).",
    "next_cycle_queue_candidates": [
      {
        "action": "Key doc-staleness finding identity and delta accounting on the existing content-hash finding_fingerprint instead of the line-embedded finding id, or exclude ARIA-owned living ledgers (docs/reviews/orphan-findings.md) from the adapter's delta accounting, so per-cycle appends stop re-minting ~40 ids of unchanged content.",
        "id": "c1-fingerprint-keyed-delta-and-living-ledger-exclusion",
        "owner": "Adapter surface (tools/aria-adapters, prose) plus kernel feedback sampling lane (feedback_store sample pool, aria-kernel maintenance lane, kernel-self-change PR route).",
        "unblocks": "Delta pressure that fires only on real documentation drift; judge capacity spent on new content only."
      },
      {
        "action": "Give the minted evidence/adversarial judge envelopes a scheduled executor drain (the backlog as a first-class dispatch source), so consensus can fire by construction once fan-out has minted.",
        "id": "c2-schedule-judge-envelope-drain",
        "owner": "Executor lane (ci_executor/autonomy orchestrator phases, prose grade), aria-kernel maintenance lane.",
        "unblocks": "Steps 2, 4 and 5 of this plan; ends prior-locked calibration for every SHADOW adapter."
      },
      {
        "action": "When a shadow-raw-delta pressure re-fires for a tool whose judgment backlog is already open and pending, fold the new delta into the existing backlog item instead of minting a fresh queue item and planner envelope (the pending-only dedup at aria-kernel/aria_kernel/next_cycle_queue.py:148 is the extension point).",
        "id": "c3-fold-delta-remints-into-open-backlog",
        "owner": "aria-kernel maintenance lane (queue and pressure surfaces), kernel-self-change PR route.",
        "unblocks": "Stops per-cycle planner spend that restates one unchanged decision while the backlog drains."
      }
    ],
    "observed_defects": [
      {
        "claim": "docs/reviews/orphan-findings.md is a living ledger appended every cycle, and doc-staleness finding ids embed line numbers, so each append re-mints ~40 finding ids per run (40 of 41 new ids in the source-cycle run, 40 of 43 the next cycle) for unchanged content referencing state-store shorthand paths like tools/registry.json. The sample rows already carry a content-hash finding_fingerprint, so a stable identity exists and is unused for delta accounting; churned re-mints also re-enter the sample pool (one pending sample item is an orphan-findings.md row).",
        "consequence": "The delta pressure's set-level signal is ~97 percent self-inflicted churn from ARIA's own output document, judge and sample capacity is spent re-deciding identical content under fresh ids, and the pressure can re-fire indefinitely without any real documentation drift.",
        "id": "OBS-qi8b67-living-ledger-line-churn",
        "remediation_in_plan": "Candidate c1. No code changed by this response (read-only seat, .claude/agents/aria-autonomy-planner.md:39)."
      },
      {
        "claim": "Eighty judge envelopes for this adapter's findings were minted across 2026-08-10 through 2026-08-17 and zero have outputs; all six judgment samples are pending; operator feedback rows for this tool number zero. Consequently every calibrated_weights block in every pressure record still carries the uniform prior (tp=0, fp=0, posterior_mean 0.8, multiplier 1.0).",
        "consequence": "The 'judge' half of this pressure's own recommended action has no scheduled drain: the mint side is automated and idempotent while the execution side waits on nothing in particular, so calibration is structurally starved for every SHADOW adapter, not only this one - the same mechanism-without-a-caller class the judge fan-out module was built to close on the mint side.",
        "id": "OBS-qi8b67-judge-fanout-minted-but-undrained",
        "remediation_in_plan": "Step 2; candidate c2."
      },
      {
        "claim": "Queue dedup spans only pending rows (aria-kernel/aria_kernel/next_cycle_queue.py:148), so the +3 successor cycle minted a second queue item (qi-ccfd8bb2fcdc, consumed 2026-08-17) and a second planner envelope (AIR-aria-autonomy-planner-e7f928f5e249, still without an output) for the same single cause - the unjudged backlog this response plans.",
        "consequence": "One unresolved cause pays for a planner invocation per delta cycle. Until verdicts land, every future positive delta re-mints another envelope that can only restate this plan.",
        "id": "OBS-qi8b67-duplicate-planner-envelopes-per-backlog",
        "remediation_in_plan": "Candidate c3; the sibling envelope AIR-aria-autonomy-planner-e7f928f5e249 should be adjudicated as superseded by this response rather than paid again."
      }
    ],
    "pedagogy": {
      "downstream_surface": "The adapter lifecycle gate SHADOW to ACTIVE, the shadow_raw_delta source weight used in every future cycle's pressure scoring, the judge/consensus lanes' backlog, the next-cycle queue's planner-token spend, and ultimately whether stale documentation across docs/** gets an authorized automated detector.",
      "evidence_that_proves_the_result": "After step 2 or 3: judgment-samples.jsonl rows for this tool leave pending and ai_judge/operator verdict rows exist. After step 4: a calibrated_weights block records nonzero tp+fp for shadow_raw_delta, and adapter-calibration precision history returns rows. After step 5: the registry row for doc-staleness-adapter reads ACTIVE via a transition event, or a recorded refusal names the failed gate. Each check is a ledger read, not a claim.",
      "what_breaks_if_skipped_or_guessed": "Skipping judging leaves every calibrated weight at its untouched prior forever (the recorded pressure files already prove this: tp=0, fp=0 in every block), so pressure scoring never learns, the readiness blocker operator_precision_unjudged never clears, and the adapter can neither be trusted nor retired - it burns ~1291 cost units per cycle producing findings nobody may act on. Guessing instead of judging (marking findings true in bulk) would poison both calibrations at once: source weights and promotion precision derive from the same verdict rows.",
      "what_must_be_done": "The doc-staleness adapter watches every markdown file under docs/ for references to repository paths that no longer exist. It runs in SHADOW, meaning it observes and records but its findings carry no authority yet. Its raw finding count rose (+1, then +3), and before those findings may influence anything - source weights, precision, promotion - a sample of them must receive true_positive/false_positive verdicts. The sampling already happened automatically (six samples, thirty findings, all pending) and eighty judge envelopes are already minted; the work is to execute the judges (or record operator verdicts via the CLI printed inside each sample row), let consensus fold the verdicts, and only then read calibration or consider promotion.",
      "why_it_matters": "SHADOW exists so a new detector earns trust with evidence instead of being trusted by assertion. Verdicts are the only currency: they become tp/fp buckets, buckets become precision, precision history unlocks the readiness gate, and the readiness gate is the single door from SHADOW to ACTIVE. The spot-verified samples show both classes are present - genuinely dead references (a doc citing apps/hr-service/schema.graphql, which does not exist) and boundary cases (ARIA's own review ledger citing state-store shorthand paths) - which is precisely what judgment is for."
    },
    "queue_plan": {
      "adapter_state_observed": {
        "count_delta_next_cycle": "+3 (1148 to 1151)",
        "count_delta_source_cycle": "+1 (1147 to 1148), matching the pressure reason",
        "findings_per_run_current": 1151,
        "judge_envelopes_for_tool": "80 unique evidence_judgment/adversarial_judgment requests minted 2026-08-10 through 2026-08-17 (judgment_group_id pattern judge:doc-staleness-adapter:<run_id>:<finding_id>), with 0 outputs recorded",
        "judgment_samples": "6 samples, one per cycle since the source cycle, 5 findings each, all status pending",
        "latest_run_cycle": "cyc-20260818T145537Z-auto",
        "latest_run_status": "ok",
        "observation_basis": "Rows read from .aria-state-store/tools/{registry.json,runs.jsonl,raw-findings.jsonl,judgment-samples.jsonl,operator-feedback.jsonl,queues/next_cycle_queue.jsonl,agent-invocations/requests.jsonl}. Runtime artifacts, named in prose only, because they are not repo files and cannot earn repo-verified grade.",
        "operator_feedback_rows_for_tool": 0,
        "raw_finding_rows_for_tool": 14929,
        "recorded_runs": 13,
        "registry_status": "SHADOW",
        "registry_updated_at": "2026-08-18T14:57:45+00:00",
        "run_cost_units": "1291 of 4000 allowed by the tool manifest",
        "tool_id": "doc-staleness-adapter"
      },
      "blocked": false,
      "delta_decomposition": {
        "next_cycle_new_ids": "43 new against 40 retired: 40 orphan-findings.md churn plus 3 content-new rows referencing libs/backend-common/src/finding-registry/finding.entity.ts and finding-registry.service.ts - both verified absent (the directory exists but holds only finding-event.ts, finding-event.spec.ts, index.ts).",
        "role_of_request_evidence_refs": "The twenty request evidence_refs are the head of the adapter run's declared read surface over docs/** (the mint site attaches the run's read_paths as pressure evidence; that site lives in pressure.py, prose grade because the file drifted from target_sha post-snapshot). They prove the scan surface is real and admissible; the delta findings themselves are ledger rows.",
        "source_cycle_new_ids": "41 new finding ids against 40 retired: 40 are line-shift re-mints from the living ledger docs/reviews/orphan-findings.md (finding ids embed line numbers; each per-cycle append shifts every later line), and exactly 1 is content-new - docs/reviews/form-write-auditor/2026-08-16-aquamobil-form-write-paths.md line 337 referencing apps/hr-service/schema.graphql, verified absent in the workspace. The net +1 the pressure reports equals the one content-new finding.",
        "spot_verified_sampled_targets": "From the pending samples, these referenced paths are verified absent in the workspace, so their findings are decidable by a judge without archaeology: apps/farm-service/src/infrastructure/tenant-connection-bootstrap.service.ts, tools/aria-poc/codex_runtime.py, apps/hr-service/schema.graphql, apps/hydroponics-service/src/middleware/tenant-schema.middleware.ts. The orphan-findings.md rows referencing tools/registry.json name a path that is absent in the repo but is state-store shorthand for a runtime file - the judgment-worthy boundary case the judges must classify, not this seat."
      },
      "pressure_id": "pressure:shadow-raw-delta:doc-staleness-adapter",
      "queue_item_id": "qi-8b671726dc6f",
      "resolution": "drain_dispatched_judgments_then_calibrate",
      "source_cycle_id": "cyc-20260816T182612Z-auto",
      "steps": [
        {
          "action": "Keep the SHADOW lane running unchanged. The adapter is registered in SHADOW, which is a runner-required status, and the runs ledger shows 13 ok runs through cyc-20260818T145537Z-auto at stable cost.",
          "effect": "Raw doc-staleness observations keep accruing and each positive count delta re-arms this same sample-and-judge pressure, keeping the calibration pipeline fed.",
          "legality": "RUNNER_REQUIRED_STATUSES includes SHADOW (aria-kernel/aria_kernel/tool_registry.py:38).",
          "owner_surface": "Cycle tools phase plus manifest sync (cycle.py, named in prose; worktree blob differs from this request's target_sha).",
          "seq": 1
        },
        {
          "action": "Drain the already-minted judge envelopes. Eighty evidence/adversarial judgment requests for this adapter's findings sit in the requests ledger with zero outputs; the fan-out is idempotent, so executing the existing envelopes (not re-minting) is the whole step.",
          "effect": "Each sampled finding gains the two unique ai_judge verdicts the consensus gate requires; disagreements park as judge_disagreement uncertainties for arbiter tie-break instead of silently stalling.",
          "legality": "Consensus requires two unique judges (aria-kernel/aria_kernel/feedback_store.py:377); disagreement is recorded, not dropped (feedback_store.py:448). The dual-judge fan-out module and its idempotency live in judge_fanout.py (prose grade, post-snapshot blob).",
          "owner_surface": "Executor drain lane (ci_executor, prose) dispatching aria-evidence-judge and aria-adversarial-judge per docs/aria/PIPELINES.md section 5 (prose).",
          "seq": 2
        },
        {
          "action": "In parallel, offer the operator the batch verdict lane for the six pending samples (thirty findings): each sample row embeds its own CLI (record one verdict per finding, or record-batch per sample) with the closed verdict vocabulary true_positive|false_positive.",
          "effect": "Human verdicts land on the same feedback surface as AI consensus, reaching human_judged or mixed_judged precision status - either accepted status unblocks readiness identically.",
          "legality": "Sample minting and embedded instructions at aria-kernel/aria_kernel/feedback_store.py:550 and feedback_store.py:582; recording at feedback_store.py:201 and feedback_store.py:259; verdict vocabulary at feedback_store.py:17; sample pool selection at feedback_store.py:612; accepted precision statuses at aria-kernel/aria_kernel/readiness.py:13.",
          "owner_surface": "Operator feedback CLI lane; this seat projects only (.claude/agents/aria-autonomy-planner.md:39).",
          "seq": 3
        },
        {
          "action": "Let verdicts reach both calibrations before trusting either: source-weight calibration buckets tp/fp per source and computes precision, and the adapter calibration reporter accumulates per-adapter precision history.",
          "effect": "The shadow_raw_delta source weight moves off its untouched prior (every calibrated_weights block in every recorded pressure file still shows tp=0, fp=0, posterior_mean 0.8, multiplier 1.0 - proof no verdict has ever reached calibration), and precision_status exits unjudged, clearing the operator_precision_unjudged readiness blocker.",
          "legality": "tp/fp bucketing and precision at aria-kernel/aria_kernel/calibration.py:76 through calibration.py:87; report generation at aria-kernel/aria_kernel/adapter_calibration.py:34; history read at adapter_calibration.py:117; unjudged blocker at aria-kernel/aria_kernel/readiness.py:37 and readiness.py:78.",
          "owner_surface": "Autonomy calibration phases (autonomy_orchestrator.py, prose grade - worktree blob differs from target_sha).",
          "seq": 4
        },
        {
          "action": "Only after judged precision exists, evaluate promotion by either authority: the auto-promote token when history spans the policy minimum at or above the precision floor, otherwise an operator approval ref - both through the single readiness gate, then the transition matrix.",
          "effect": "SHADOW graduates to ACTIVE exactly when the judged evidence supports it, which is the durable form of the recommended action's 'before calibration' ordering: no weight trust and no promotion ahead of verdicts.",
          "legality": "Token mint at aria-kernel/aria_kernel/adapter_calibration.py:67 with insufficient-history refusal at adapter_calibration.py:119 and the stays-in-SHADOW contract at adapter_calibration.py:90; promote_tool at aria-kernel/aria_kernel/promotion.py:11 with the operator fail-over at promotion.py:52 and the readiness gate at promotion.py:56; SHADOW-to-ACTIVE arc in the transition matrix at aria-kernel/aria_kernel/tool_registry.py:836.",
          "owner_surface": "promote_tool through the operator/kernel CLI lane. Projection only from this seat (.claude/agents/aria-autonomy-planner.md:39).",
          "seq": 5
        }
      ]
    }
  },
  "evidence_refs": [
    "docs/DEPLOY.md",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md",
    "docs/HMI_TRANSFORMATION_PLAN.md",
    "docs/LORAWAN_API.md",
    "docs/LORAWAN_ARCHITECTURE.md",
    "docs/LORAWAN_SETUP.md",
    "docs/PID_SIMULATOR.md",
    "docs/SCADA.md",
    "docs/SCADA_BUILDER_WIRING.md",
    "docs/SCADA_EDGE_DEPLOY.md",
    "docs/SCADA_SIMULATION_MODE.md",
    "docs/admin-panel-triangle-audit/2026-05-20/README.md",
    "docs/admin-panel-triangle-audit/2026-05-20/admin-billing/implementation-record.md",
    "docs/admin-panel-triangle-audit/2026-05-20/decision-record.md",
    "docs/admin-panel-triangle-audit/2026-05-20/findings.md",
    "docs/admin-panel-triangle-audit/2026-05-20/implementation-log.md",
    "docs/admin-panel-triangle-audit/2026-05-20/out-of-scope-observations.md",
    "docs/admin-panel-triangle-audit/2026-05-20/validation.md",
    "docs/admin-panel-triangle-audit/2026-05-21/admin-billing-runtime-contract/README.md",
    "docs/admin-panel-triangle-audit/2026-05-22/admin-security/README.md",
    "aria-kernel/aria_kernel/tool_registry.py:38",
    "aria-kernel/aria_kernel/tool_registry.py:836",
    "aria-kernel/aria_kernel/feedback_store.py:17",
    "aria-kernel/aria_kernel/feedback_store.py:201",
    "aria-kernel/aria_kernel/feedback_store.py:259",
    "aria-kernel/aria_kernel/feedback_store.py:377",
    "aria-kernel/aria_kernel/feedback_store.py:448",
    "aria-kernel/aria_kernel/feedback_store.py:550",
    "aria-kernel/aria_kernel/feedback_store.py:582",
    "aria-kernel/aria_kernel/feedback_store.py:612",
    "aria-kernel/aria_kernel/calibration.py:76",
    "aria-kernel/aria_kernel/calibration.py:87",
    "aria-kernel/aria_kernel/adapter_calibration.py:34",
    "aria-kernel/aria_kernel/adapter_calibration.py:67",
    "aria-kernel/aria_kernel/adapter_calibration.py:90",
    "aria-kernel/aria_kernel/adapter_calibration.py:117",
    "aria-kernel/aria_kernel/adapter_calibration.py:119",
    "aria-kernel/aria_kernel/readiness.py:13",
    "aria-kernel/aria_kernel/readiness.py:37",
    "aria-kernel/aria_kernel/readiness.py:78",
    "aria-kernel/aria_kernel/promotion.py:11",
    "aria-kernel/aria_kernel/promotion.py:52",
    "aria-kernel/aria_kernel/promotion.py:56",
    "aria-kernel/aria_kernel/next_cycle_queue.py:148",
    ".claude/agents/aria-autonomy-planner.md:39",
    ".claude/knowledge/layer-2-aria-canonical-envelope.md:68"
  ],
  "notes": "Queue item resolved, not blocked. The recommended action's sample half is already automated and its judge half is already minted - what is missing is drain and verdicts, so the plan is: run the eighty existing judge envelopes (or clear the thirty-finding operator worklist), fold verdicts through consensus into both calibrations, and only then evaluate SHADOW-to-ACTIVE through the single readiness gate. Three defects travel with one queue candidate each: living-ledger line churn re-minting ~40 ids per cycle, a minted-but-undrained judge backlog that keeps every weight at its prior, and duplicate planner envelopes for one cause (the sibling request AIR-aria-autonomy-planner-e7f928f5e249 should be marked superseded by this plan). This seat wrote nothing outside its expected_output_path and changed no code.",
  "request_id": "AIR-aria-autonomy-planner-1bc22d4f3460",
  "role": "maintenance_utility",
  "satisfaction_matrix": [
    {
      "evidence": "Resolved queue item qi-8b671726dc6f (pressure pressure:shadow-raw-delta:doc-staleness-adapter, source cycle cyc-20260816T182612Z-auto, recommended action 'sample and judge increased SHADOW findings before calibration') into the concrete queue plan in details.queue_plan. The pressure's subject is real and its remedy is reachable on stable kernel surfaces. Subject: the doc-staleness adapter runs in SHADOW, a runner-required status (aria-kernel/aria_kernel/tool_registry.py:38), and its source-cycle run raised the raw finding count 1147 to 1148 (+1, matching the pressure reason), with the next cycle at +3 - counts read from the runs and raw-findings ledgers (runtime rows, prose grade). The request's twenty evidence_refs all resolve at the workspace; they are the adapter run's declared read surface over docs/**, which is what the mint site attaches as pressure evidence, not the delta findings themselves - the delta findings live in the raw-findings ledger. Remedy reachability, proven per step: sampling is already automatic (generate_judgment_sample at aria-kernel/aria_kernel/feedback_store.py:550 minted six per-cycle samples for this tool, thirty findings, every one status pending); judging has two live lanes - eighty evidence/adversarial judge envelopes for this adapter's findings are minted and idempotent but have zero outputs, and the operator batch lane is printed inside each sample row (feedback_store.py:582, record at feedback_store.py:201, batch at feedback_store.py:259, closed verdict vocabulary at feedback_store.py:17); consensus needs two unique judges (feedback_store.py:377) with disagreement parked as uncertainty (feedback_store.py:448); verdicts then feed source-weight calibration tp/fp buckets (aria-kernel/aria_kernel/calibration.py:76 through calibration.py:87) and adapter precision history (aria-kernel/aria_kernel/adapter_calibration.py:34, adapter_calibration.py:117), which is the only exit from the operator_precision_unjudged readiness blocker (aria-kernel/aria_kernel/readiness.py:37, readiness.py:78; accepted statuses readiness.py:13) toward SHADOW to ACTIVE strictly through promote_tool (aria-kernel/aria_kernel/promotion.py:11; auto-promote ineligibility fail-over at promotion.py:52; readiness gate at promotion.py:56; transition matrix at tool_registry.py:836). A blocked verdict was weighed and rejected as untrue: every mechanism in the chain exists, is registered, and is idempotently re-invokable; what is missing is drain and verdicts, and the plan schedules exactly that. Three structural defects observed alongside (living-ledger line churn re-minting ~40 finding ids per run, a minted-but-undrained judge backlog that leaves every calibrated weight at its prior, and duplicate planner envelopes for one unjudged-backlog cause past the pending-only dedup at aria-kernel/aria_kernel/next_cycle_queue.py:148) are recorded in details.observed_defects with queue candidates, not misreported as blockers.",
      "evidence_refs": [
        "docs/DEPLOY.md",
        "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md",
        "docs/HMI_TRANSFORMATION_PLAN.md",
        "docs/LORAWAN_API.md",
        "docs/LORAWAN_ARCHITECTURE.md",
        "docs/LORAWAN_SETUP.md",
        "docs/PID_SIMULATOR.md",
        "docs/SCADA.md",
        "docs/SCADA_BUILDER_WIRING.md",
        "docs/SCADA_EDGE_DEPLOY.md",
        "docs/SCADA_SIMULATION_MODE.md",
        "docs/admin-panel-triangle-audit/2026-05-20/README.md",
        "docs/admin-panel-triangle-audit/2026-05-20/admin-billing/implementation-record.md",
        "docs/admin-panel-triangle-audit/2026-05-20/decision-record.md",
        "docs/admin-panel-triangle-audit/2026-05-20/findings.md",
        "docs/admin-panel-triangle-audit/2026-05-20/implementation-log.md",
        "docs/admin-panel-triangle-audit/2026-05-20/out-of-scope-observations.md",
        "docs/admin-panel-triangle-audit/2026-05-20/validation.md",
        "docs/admin-panel-triangle-audit/2026-05-21/admin-billing-runtime-contract/README.md",
        "docs/admin-panel-triangle-audit/2026-05-22/admin-security/README.md",
        "aria-kernel/aria_kernel/tool_registry.py:38",
        "aria-kernel/aria_kernel/tool_registry.py:836",
        "aria-kernel/aria_kernel/feedback_store.py:17",
        "aria-kernel/aria_kernel/feedback_store.py:201",
        "aria-kernel/aria_kernel/feedback_store.py:259",
        "aria-kernel/aria_kernel/feedback_store.py:377",
        "aria-kernel/aria_kernel/feedback_store.py:448",
        "aria-kernel/aria_kernel/feedback_store.py:550",
        "aria-kernel/aria_kernel/feedback_store.py:582",
        "aria-kernel/aria_kernel/feedback_store.py:612",
        "aria-kernel/aria_kernel/calibration.py:76",
        "aria-kernel/aria_kernel/calibration.py:87",
        "aria-kernel/aria_kernel/adapter_calibration.py:34",
        "aria-kernel/aria_kernel/adapter_calibration.py:67",
        "aria-kernel/aria_kernel/adapter_calibration.py:90",
        "aria-kernel/aria_kernel/adapter_calibration.py:117",
        "aria-kernel/aria_kernel/adapter_calibration.py:119",
        "aria-kernel/aria_kernel/readiness.py:13",
        "aria-kernel/aria_kernel/readiness.py:37",
        "aria-kernel/aria_kernel/readiness.py:78",
        "aria-kernel/aria_kernel/promotion.py:11",
        "aria-kernel/aria_kernel/promotion.py:52",
        "aria-kernel/aria_kernel/promotion.py:56",
        "aria-kernel/aria_kernel/next_cycle_queue.py:148",
        ".claude/agents/aria-autonomy-planner.md:39",
        ".claude/knowledge/layer-2-aria-canonical-envelope.md:68"
      ],
      "id": "queue_item_projected",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
