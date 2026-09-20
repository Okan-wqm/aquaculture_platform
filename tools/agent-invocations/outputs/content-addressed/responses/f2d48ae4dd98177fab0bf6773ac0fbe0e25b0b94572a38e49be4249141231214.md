{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-35509466473",
  "claim_id": "claim_59e2a0f582b5c3ea",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:3564b263b330e93ff2082753794387c30c6b9e382802878d171ad0ceaf311460",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-autonomy-planner",
    "agent_text": "Grounding done. Summary of what I found before the envelope:\n\n- The request's 20 `evidence_refs` are the run's alphabetically-first 20 `read_paths`, not the flagged docs, so I re-derived the rule's matches inside the slice: 72 backtick repo-path spans, 31 of which do not resolve in this worktree \u2014 all in three docs (`HMI_TRANSFORMATION_PLAN.md` 9, `FUXA_GAP_IMPLEMENTATION_PLAN.md` 21, `SCADA_BUILDER_WIRING.md` 1); the other 17 docs carry none.\n- Those 31 split into three semantic classes: 20 are plan lines marked `YEN\u0130` (new \u2014 the path never existed), 9 are plan paths whose files were built under a different directory, 2 are references the doc presents as existing files that are now gone. Under the rule's own message (\"no longer exists\") precision on this slice is ~0.06\u20130.35; under a \"does not resolve\" reading it is 1.0 \u2014 on either side of the 0.85 SHADOW\u2192ACTIVE bar. That reading, not the judges, decides calibration, so it must be pinned before any vote.\n- The \"sample and judge\" machinery already exists as a nightly phase (judgment sample \u2192 two-judge fan-out \u2192 consensus \u2192 arbiter \u2192 calibration); the projection below sequences it for this delta, adds the count cross-check, the rubric, stratified sampling, the drain-health precondition, and four follow-on candidates.\n\n```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-autonomy-planner-310a6c39c90e\",\n  \"claim_id\": \"claim_59e2a0f582b5c3ea\",\n  \"agent_id\": \"aria-autonomy-planner\",\n  \"role\": \"maintenance_utility\",\n  \"status\": \"submitted\",\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/general/round-na-maintenance_utility-AIR-aria-autonomy-planner-310a6c39c90e.md\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"queue_item_projected\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"Queue item qi-557f4d446e57 is resolved into a concrete next-cycle projection (details.projection): derive the +delta finding set of doc-staleness-adapter for cycle cyc-20260918T153436Z-auto keyed by (doc path, referenced path); cross-check the adapter's per-doc missingRefs against the planner's independent read of the 20-doc evidence slice (72 repo-path spans checked, 31 unresolved in the request worktree: HMI_TRANSFORMATION_PLAN 9, FUXA_GAP_IMPLEMENTATION_PLAN 21, SCADA_BUILDER_WIRING 1, the other 17 docs 0); pin the rule's claim semantics before any judge votes, because the 31 split into plan-declared new paths marked YEN\u0130 (20), plan paths realized elsewhere (9) and references that existed and are gone (2), so measured precision is roughly 0.06-0.35 under a staleness reading and 1.0 under a non-resolution reading, on either side of the 0.85 SHADOW->ACTIVE bar; then stratified two-judge sampling with consensus, and only after that may precision_history, weight calibration or promotion readiness consume this run. The doc:line refs are the evidence; the existence verdicts are a planner working-tree probe (unverified grade) that the judge lane re-verifies at the run snapshot SHA.\",\n      \"evidence_refs\": [\n        \"docs/HMI_TRANSFORMATION_PLAN.md:518\",\n        \"docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:37\",\n        \"docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:161\",\n        \"docs/SCADA_BUILDER_WIRING.md:113\",\n        \"docs/DEPLOY.md:83\",\n        \"docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:208\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \"docs/HMI_TRANSFORMATION_PLAN.md:518\",\n    \"docs/HMI_TRANSFORMATION_PLAN.md:519\",\n    \"docs/HMI_TRANSFORMATION_PLAN.md:520\",\n    \"docs/HMI_TRANSFORMATION_PLAN.md:592\",\n    \"docs/HMI_TRANSFORMATION_PLAN.md:665\",\n    \"docs/HMI_TRANSFORMATION_PLAN.md:666\",\n    \"docs/HMI_TRANSFORMATION_PLAN.md:877\",\n    \"docs/HMI_TRANSFORMATION_PLAN.md:878\",\n    \"docs/HMI_TRANSFORMATION_PLAN.md:879\",\n    \"docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:37\",\n    \"docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:38\",\n    \"docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:58\",\n    \"docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:73\",\n    \"docs/FUXA...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 195717,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 195717,
      "cache_read_input_tokens": 4246816,
      "inference_geo": "not_available",
      "input_tokens": 56,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 5090,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 5090,
          "cache_read_input_tokens": 219824,
          "input_tokens": 2,
          "output_tokens": 41757,
          "type": "message"
        }
      ],
      "output_tokens": 88617,
      "output_tokens_details": {
        "thinking_tokens": 62074
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "evidence_slice_analysis": {
      "method": "every backtick span starting with apps/ e2e/ infrastructure/ libs/ platform/ scripts/ sens-api-gateway/ tools/ web/ in the 20 docs was collected with line numbers (the adapter's candidateRef rule: trailing :line suffix stripped, spans with whitespace / glob / placeholder characters ignored); each referenced path was then probed for existence in the request worktree",
      "per_doc_expected_missing_refs": {
        "docs/DEPLOY.md": 0,
        "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md": 21,
        "docs/HMI_TRANSFORMATION_PLAN.md": 9,
        "docs/LORAWAN_API.md": 0,
        "docs/LORAWAN_ARCHITECTURE.md": 0,
        "docs/LORAWAN_SETUP.md": 0,
        "docs/PID_SIMULATOR.md": 0,
        "docs/SCADA.md": 0,
        "docs/SCADA_BUILDER_WIRING.md": 1,
        "docs/SCADA_EDGE_DEPLOY.md": 0,
        "docs/SCADA_SIMULATION_MODE.md": 0,
        "docs/admin-panel-triangle-audit/2026-05-20/README.md": 0,
        "docs/admin-panel-triangle-audit/2026-05-20/admin-billing/implementation-record.md": 0,
        "docs/admin-panel-triangle-audit/2026-05-20/decision-record.md": 0,
        "docs/admin-panel-triangle-audit/2026-05-20/findings.md": 0,
        "docs/admin-panel-triangle-audit/2026-05-20/implementation-log.md": 0,
        "docs/admin-panel-triangle-audit/2026-05-20/out-of-scope-observations.md": 0,
        "docs/admin-panel-triangle-audit/2026-05-20/validation.md": 0,
        "docs/admin-panel-triangle-audit/2026-05-21/admin-billing-runtime-contract/README.md": 0,
        "docs/admin-panel-triangle-audit/2026-05-22/admin-security/README.md": 0
      },
      "reading_of_the_result": "Within the slice, the adapter's finding text is accurate for at most 2 of 31 items under reading A (11 of 31 if plan_path_diverged is counted as stale) and for 31 of 31 under reading B. The slice is not the delta; it shows that the rule's precision is a function of its pinned claim, which is why the claim is pinned in step 3 before any judge votes.",
      "resolved_controls_41": {
        "docs/DEPLOY.md": "lines 83, 89 (scripts/deploy/droplet-up.sh, scripts/deploy/production-host-control-plane.sh)",
        "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md": "G\u00dcNCELLE lines 56, 57, 111, 125, 126, 127, 141, 142, 160, 174, 189, 206, 207, 209, 238, 255, 305, 306, 307, 322 and the realized YEN\u0130 line 208 (PieChartRenderer.tsx exists: a plan item that was built)",
        "docs/PID_SIMULATOR.md": "lines 659, 660, 661",
        "docs/SCADA_BUILDER_WIRING.md": "lines 23, 47, 65, 74, 122, 131",
        "docs/admin-panel-triangle-audit/2026-05-20/admin-billing/implementation-record.md": "line 27",
        "docs/admin-panel-triangle-audit/2026-05-21/admin-billing-runtime-contract/README.md": "lines 28 (two spans), 48, 49, 50, 61",
        "docs/admin-panel-triangle-audit/2026-05-22/admin-security/README.md": "lines 22, 23"
      },
      "totals": {
        "docs": 20,
        "repo_path_spans_checked": 72,
        "resolved": 41,
        "unresolved": 31
      },
      "trust_grade": "planner_probe_unverified: the doc:line refs are evidence; the existence verdicts are a working-tree probe in the request worktree, not at the run snapshot SHA, and the judge lane re-verifies them",
      "unresolved_by_stratum": {
        "M_plan_path_realized_elsewhere_9": [
          "docs/HMI_TRANSFORMATION_PLAN.md:518 -> apps/sensor-service/src/modules/scada-runtime/alarm-engine.service.ts (probe: apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts exists)",
          "docs/HMI_TRANSFORMATION_PLAN.md:519 -> apps/sensor-service/src/modules/scada-runtime/alarm-storage.service.ts (probe: .../scada-runtime/services/alarm-storage.service.ts exists)",
          "docs/HMI_TRANSFORMATION_PLAN.md:520 -> apps/sensor-service/src/modules/scada-runtime/notification.service.ts (probe: .../scada-runtime/services/notification.service.ts exists)",
          "docs/HMI_TRANSFORMATION_PLAN.md:592 -> apps/sensor-service/src/modules/scada-runtime/daq-storage.service.ts (probe: .../scada-runtime/services/daq-storage.service.ts exists)",
          "docs/HMI_TRANSFORMATION_PLAN.md:665 -> apps/sensor-service/src/modules/scada-runtime/script-engine.service.ts (probe: .../scada-runtime/services/script-engine.service.ts exists)",
          "docs/HMI_TRANSFORMATION_PLAN.md:666 -> apps/sensor-service/src/modules/scada-runtime/scheduler.service.ts (probe: .../scada-runtime/services/scheduler.service.ts exists)",
          "docs/HMI_TRANSFORMATION_PLAN.md:877 -> apps/sensor-service/src/modules/scada-runtime/scada-runtime.module.ts (probe: apps/sensor-service/src/scada-runtime/scada-runtime.module.ts exists)",
          "docs/HMI_TRANSFORMATION_PLAN.md:878 -> apps/sensor-service/src/modules/scada-runtime/scada-runtime.gateway.ts (probe: apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts exists)",
          "docs/HMI_TRANSFORMATION_PLAN.md:879 -> apps/sensor-service/src/modules/scada-runtime/tag-manager.service.ts (probe: .../scada-runtime/services/tag-manager.service.ts exists)"
        ],
        "P_plan_declared_new_path_20": [
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:37 -> apps/sensor-service/src/protocol/adapters/webapi-adapter.ts (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:38 -> apps/sensor-service/src/protocol/adapters/webapi-adapter.types.ts (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:58 -> web/modules/sensor-module/src/components/scada-builder/tag-config/TagDaqSettingsPanel.tsx (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:73 -> web/modules/sensor-module/src/components/scada-builder/tag-config/TagBrowserDialog.tsx (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:74 -> web/modules/sensor-module/src/components/scada-builder/tag-config/ProtocolTagTree.tsx (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:75 -> web/modules/sensor-module/src/hooks/useTagBrowser.ts (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:90 -> apps/sensor-service/src/scada-runtime/services/device-health.service.ts (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:109 -> web/modules/sensor-module/src/services/TagPlaceholderResolver.ts (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:110 -> web/modules/sensor-module/src/hooks/useTagPlaceholder.ts (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:143 -> web/modules/sensor-module/src/hooks/useViewLifecycle.ts (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:175 -> web/modules/sensor-module/src/components/scada-builder/tag-config/ScaleScriptEditor.tsx (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:222 -> apps/sensor-service/src/scada-runtime/services/report.service.ts (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:223 -> web/modules/sensor-module/src/components/scada-operator/ReportDialog.tsx (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:254 -> web/modules/sensor-module/src/hooks/useAutoSave.ts (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:269 -> web/modules/sensor-module/src/components/scada-builder/ProjectExportDialog.tsx (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:270 -> web/modules/sensor-module/src/components/scada-builder/ProjectImportDialog.tsx (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:271 -> web/modules/sensor-module/src/services/ProjectExportService.ts (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:285 -> apps/sensor-service/src/scada-runtime/services/api-key.service.ts (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:286 -> web/modules/sensor-module/src/components/scada-builder/settings/ApiKeyManager.tsx (YEN\u0130)",
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:321 -> web/modules/sensor-module/src/components/scada-builder/settings/AlarmRetentionSettings.tsx (YEN\u0130)"
        ],
        "R_existed_then_gone_candidates_2": [
          "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:161 -> web/modules/sensor-module/src/services/ScriptEngine.ts (doc marker G\u00dcNCELLE = update an existing file; probe: absent)",
          "docs/SCADA_BUILDER_WIRING.md:113 -> web/modules/sensor-module/src/store/scadaPackageStore.ts (change record 'Konum:' of a modified file; probe: absent, the store directory now holds scada/projectSlice.ts and scada/operatorSlice.ts)"
        ]
      },
      "what_the_slice_is": "The request's 20 evidence_refs are the alphabetically-first 20 read_paths of the adapter run, not the flagged docs (kernel: aria_kernel.pressure, shadow_raw_delta evidence = run read_paths[:20]); the planner therefore re-derived the rule's matches inside the slice instead of assuming the slice is the finding set."
    },
    "projection": {
      "calibration_gate": {
        "decision_table": {
          "cross_check_mismatch": "tool-health finding on the adapter's fs resolution or snapshot filter; judging waits for it",
          "reading_A_and_precision_below_threshold": "the rule cannot be promoted on this evidence; the Tier-1/2 fix is in the adapter rule (git-history existence check so 'no longer exists' is emitted only for paths that existed; plan-declared new paths become a distinct lower-severity rule with a truthful message) -- surface tools/aria-adapters/doc-staleness-adapter.ts, beyond this item's allowed_scope, routed as FO-1",
          "reading_B": "record that the rule's message must change to match its claim ('does not resolve') before promotion, because a promoted finding text saying 'no longer exists' about a never-existed path is a false claim ARIA would publish"
        },
        "kernel_owners": [
          "aria_kernel.adapter_calibration (precision_history, auto-promote token)",
          "aria_kernel.calibration.recommend_calibration (per-source weights)",
          "aria_kernel.tool_registry.transition_tool (SHADOW->ACTIVE: precision at or above threshold, zero critical FP, valid evidence chains, operator / panel / verified auto-promote authority)",
          "aria_kernel.promotion_veto (panel approval token + veto window)"
        ],
        "meaning_of_before_calibration": "No precision_history row, auto-promote token, pressure-weight recommendation or promotion-readiness computation for doc-staleness-adapter may consume the +delta of cyc-20260918T153436Z-auto until (i) the rubric decision is recorded, (ii) at least min_judged_samples consensus rows exist on delta findings covering every stratum present, (iii) the per-doc missingRefs cross-check on the evidence slice passed."
      },
      "follow_on_queue_candidates": [
        {
          "allowed_scope_fit": "beyond this item's allowed_scope (aria-kernel/**, aria-tools/**, .claude/**)",
          "change": "emit doc_references_missing_path only when the referenced path existed in git history (existed-then-gone); classify plan-declared new paths and never-existed paths as a distinct lower-severity rule whose message matches its claim",
          "gate": "precedes any SHADOW->ACTIVE promotion of the tool",
          "id": "FO-1",
          "lane": "adapter/skill authoring loop (PIPELINES section 4) with fixture cases for strata P, M and R",
          "surface": "tools/aria-adapters/doc-staleness-adapter.ts + its fixture set",
          "tier": "1-2: the false 'no longer exists' claim becomes impossible to emit"
        },
        {
          "allowed_scope_fit": "aria-kernel/**",
          "change": "carry the delta findings' doc:line evidence (from the raw-findings ledger, keyed by (doc, ref)) on the pressure instead of read_paths[:20], so the queue projection cites the findings it must sample",
          "id": "FO-2",
          "surface": "aria_kernel.pressure (shadow_raw_delta mint)",
          "tier": "2"
        },
        {
          "allowed_scope_fit": "aria-kernel/**",
          "change": "render the tool's rule claim statement / rubric into the judge envelope prompt so both judges apply one reading",
          "id": "FO-3",
          "surface": "aria_kernel.judge_fanout (judge prompt) + tool manifest claim statement",
          "tier": "2"
        },
        {
          "allowed_scope_fit": "aria-kernel/**",
          "change": "rule-aware identity for line-bearing evidence (doc path + referenced path for doc_references_missing_path) so line shifts do not mint new findings",
          "id": "FO-4",
          "surface": "aria_kernel.feedback_store.finding_fingerprint",
          "tier": "2"
        }
      ],
      "judging_rubric": {
        "claim_to_pin_before_any_vote": "(A) staleness: the doc names a repo surface that existed and is gone or moved; or (B) non-resolution: a repo-path span in the doc does not resolve at the snapshot. On the same 31 slice items the two readings give roughly 0.06-0.35 and 1.0 precision; the SHADOW->ACTIVE bar is the tool's precision threshold (0.85 default, kernel: tool_registry.transition_tool). The reading, not the judges, decides promotion. The rule's own message asserts (A).",
        "default_reading": "A, because the message and the adapter's stated purpose (a runbook naming a deleted script) both assert 'existed and is gone'",
        "false_positive_when": "the doc itself declares the path as to-be-created (YEN\u0130 / new / create) and git history never contained it: 'no longer exists' is false for a never-existed path; record class unrealized_plan_path in the judge note",
        "judge_note_must_carry": [
          "reading applied (A | B)",
          "class: stale_removed | plan_path_diverged | unrealized_plan_path | pattern_or_placeholder",
          "git-history check result for the referenced path",
          "doc marker at the cited line (YEN\u0130 / G\u00dcNCELLE / Konum: / none)"
        ],
        "plan_path_realized_elsewhere": "a plan's target path differs from where the file was built (HMI_TRANSFORMATION_PLAN 'modules/scada-runtime/*' versus realized 'scada-runtime/services/*'): under reading A this is TP only if the doc is presented as a current reference; judges MUST name the class plan_path_diverged so the arbiter and the calibration row can separate it",
        "rule": "doc_references_missing_path; adapter message: '<doc> references <path>, which no longer exists'",
        "true_positive_when": "the span is a repo-path claim (not a pattern or placeholder), it does not resolve at the run snapshot SHA, AND the doc presents the path as an existing surface (runbook step, change-record 'Konum:', update-existing marker such as G\u00dcNCELLE) or git history shows the path existed at an earlier commit"
      },
      "next_cycle_steps": [
        {
          "action": "delta = findings(cyc-20260918T153436Z-auto) minus findings(previous run of the tool), keyed by (doc path, referenced path) -- not by finding_id or finding_fingerprint, both of which embed the line number; label each delta item P (the doc line carries a to-be-created marker such as YEN\u0130), M (a file with the same basename exists under another directory) or R (neither).",
          "exit_criterion": "a delta list with stratum labels exists",
          "name": "derive_delta",
          "owner": "judgment pipeline phase (aria_kernel.cycle) over the raw-findings ledger for tool_id doc-staleness-adapter",
          "proof": "judgment_samples row for tool_id doc-staleness-adapter whose items are drawn from that list",
          "step": 1
        },
        {
          "action": "compare the run's observations[].details.missingRefs for the 20 evidence docs with evidence_slice_analysis.per_doc_expected_missing_refs (31 total: 9 / 21 / 1 / 0 x 17).",
          "exit_criterion": "counts match, or every difference is explained by a path added or removed between the run snapshot SHA and the request worktree",
          "name": "cross_check_counts",
          "owner": "same phase, read-only over the run artifact of cyc-20260918T153436Z-auto",
          "proof": "governance row (kind chosen by the kernel owner) carrying both count tables; an unexplained mismatch becomes a tool-health finding and judging waits for it",
          "step": 2
        },
        {
          "action": "record reading A (staleness: existed-then-gone) as the rule's claim unless the panel chooses B (non-resolution); attach details.projection.judging_rubric to judgment_samples.instructions and to every judge envelope minted for this tool.",
          "exit_criterion": "one reading recorded before any judge vote on this delta",
          "name": "pin_rubric",
          "owner": "panel / operator; the open HUMAN_REQUIRED adjudication on capability gap shadow_run:doc-staleness-adapter (decision memory, context not evidence) is the natural carrier",
          "proof": "governance row with the reading; the rubric text present in the sample instructions",
          "step": 3
        },
        {
          "action": "sample at least 2 delta items per stratum present in the delta, plus the four rubric anchors from the evidence slice: docs/HMI_TRANSFORMATION_PLAN.md:518 (M), docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:37 (P), docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:161 (R), docs/SCADA_BUILDER_WIRING.md:113 (R); sample_size_per_tool must be at least 6 for that cycle (the default 5 cannot hold 3 strata x 2).",
          "exit_criterion": "judgment_samples row lists items covering every stratum present",
          "name": "sample_stratified",
          "owner": "feedback_store.generate_judgment_sample (policy: genesis_policy.judgment_pipeline_policy)",
          "proof": "the row itself, items[] annotated with their stratum",
          "step": 4
        },
        {
          "action": "two independent votes per sampled item under the pinned rubric; every judge note carries the reading applied, the class, the git-history result for the referenced path and the doc marker at the cited line.",
          "exit_criterion": "at least min_judged_samples ai_consensus rows on delta items, covering every stratum present",
          "name": "judge_to_consensus",
          "owner": "judge_fanout.dispatch_judges_for_sample -> aria-evidence-judge + aria-adversarial-judge -> feedback_store.generate_ai_consensus -> aria-consensus-arbiter on split or anchor",
          "precondition": "PR-1: pending judge envelopes per role below max_pending_per_role and the executor drain alive; otherwise record the four anchors through the operator-feedback batch lane (judgment_samples.instructions.batch_cli) instead of minting envelopes that die ANCHOR_STALE",
          "proof": "ai_judge rows from at least two distinct judge_id per judgment group; ai_consensus rows; arbiter rows where the pair split",
          "step": 5
        },
        {
          "action": "let these consume the run only once step 5's exit criterion holds; apply details.projection.calibration_gate.decision_table.",
          "exit_criterion": "the recorded precision for this run is traceable to consensus rows that carry the pinned reading",
          "name": "calibrate_after_consensus",
          "owner": "adapter_calibration (precision_history, auto-promote token) / calibration.recommend_calibration (source weights) / tool_registry.transition_tool + promotion_veto (promotion)",
          "proof": "precision_history row whose inputs reference those consensus rows; the next shadow_raw_delta pressure for the tool scored with calibrated weights",
          "step": 6
        },
        {
          "action": "close qi-557f4d446e57 with the recorded reading and precision; if reading A holds and precision is below the threshold, mint FO-1 (adapter rule change) as the next queue item with an owner, and FO-2..FO-4 as kernel self_improvement candidates.",
          "exit_criterion": "queue item consumed with an outcome, not replayed",
          "name": "close_or_mint_follow_on",
          "owner": "autonomy_orchestrator next-cycle queue",
          "proof": "next-cycle queue governance rows and the daily report line",
          "step": 7
        }
      ],
      "preconditions_and_risks": [
        {
          "id": "PR-1",
          "precondition": "pending judge envelopes per role below max_pending_per_role before the judgment phase; otherwise route the anchors through the operator-feedback batch lane so the rubric decision is not blocked on the drain",
          "risk": "judge drain behind: decision memory (context, not evidence) shows five judge envelopes died ANCHOR_STALE unclaimed on 2026-09-18; minting two judges per delta finding into a stalled drain manufactures corpses, and the backlog cap (max_pending_per_role) then skips the mints so this item stalls silently"
        },
        {
          "id": "PR-2",
          "precondition": "delta and sample dedupe key for this rule = (doc path, referenced path)",
          "risk": "identity churn: finding_fingerprint hashes the evidence list (doc path + line); doc edits shift lines, so an unchanged stale reference re-enters as a new finding, inflates the raw delta and re-consumes judge capacity"
        },
        {
          "id": "PR-3",
          "precondition": "step 1 derives the delta from the raw-findings ledger; FO-2 fixes the mint",
          "risk": "pressure evidence is the run's first 20 read_paths, not the flagged doc:line refs, so the queue item is not answerable from its own refs without re-deriving the matches"
        },
        {
          "id": "PR-4",
          "precondition": "rubric attached to the sample instructions and judge envelopes; FO-3",
          "risk": "the generic judge prompt carries no per-rule claim statement, so two judges can apply readings A and B and split on every item"
        },
        {
          "id": "PR-5",
          "precondition": "step 2 tolerates documented differences between the two SHAs; judges verify at the run snapshot",
          "risk": "probe SHA drift: the planner probed the request worktree, the adapter ran at the cycle snapshot; files added or removed between them change counts"
        }
      ],
      "sample_design": {
        "dedupe_key": "(doc path, referenced path)",
        "minimum": "at least 2 items per stratum present in the delta, plus the 4 anchors",
        "negative_controls": "not judged; used in step 2 -- references that resolve must not appear as findings",
        "population": "delta findings of doc-staleness-adapter for cyc-20260918T153436Z-auto (step 1), NOT the 20-doc evidence slice: the slice is the run's first 20 read_paths and serves only the count cross-check and the rubric anchors",
        "strata": {
          "M": "plan path realized elsewhere: a file with the same basename exists under another directory",
          "P": "plan-declared new path: the doc line marks the path as to be created (YEN\u0130 / new / create)",
          "R": "reference the doc presents as an existing file (change-record 'Konum:', update marker G\u00dcNCELLE, runbook step) that is absent"
        },
        "why_stratified": "stratified_by_uncertainty (the phase default) picks by the kernel's uncertainty score, which is blind to the semantic class; a 5-item sample can land entirely in stratum P and measure the rule on the one class where its message is false"
      }
    },
    "provenance": {
      "actions_taken": "none beyond reading: nothing was written, dispatched, implemented or merged",
      "decision_memory_used_as_context_not_evidence": [
        "2026-09-18: five judge envelopes (evidence and adversarial judges) died ANCHOR_STALE unclaimed -> PR-1",
        "2026-08-18: HUMAN_REQUIRED genesis:c9c7b1a0e7719a1b open on capability gap shadow_run:doc-staleness-adapter -> the panel item that should carry the rubric decision and FO-1"
      ],
      "evidence_read": "all 20 evidence_refs docs: backtick repo-path spans collected with line numbers across the 20 files; docs/FUXA_GAP_IMPLEMENTATION_PLAN.md lines 1-95 and every marker line, docs/HMI_TRANSFORMATION_PLAN.md lines 1-30 and 505-529, docs/SCADA_BUILDER_WIRING.md lines 1-135 read in full context",
      "identity_lookup": "the rendered request carries no claim_id; mcp aria progress_tail for this request_id returned claim_59e2a0f582b5c3ea",
      "kernel_surfaces_read_within_allowed_scope_not_cited": [
        "aria_kernel.autonomy_orchestrator (queue projection mint: evidence_refs from the pressure record, must_satisfy queue_item_projected, allowed_scope)",
        "aria_kernel.pressure (shadow_raw_delta: raw count delta versus the previous run; evidence = run read_paths[:20])",
        "aria_kernel.cycle judgment pipeline phase (generate_judgment_sample -> dispatch_judges_for_sample -> generate_ai_consensus -> arbiter; sample_size_per_tool default 5 and max_pending_per_role default 32 from judgment_pipeline_policy)",
        "aria_kernel.feedback_store (generate_judgment_sample, _sampleable_raw_findings, finding_fingerprint hashes the evidence list)",
        "aria_kernel.judge_fanout (two judges per finding, generic prompt, backlog cap)",
        "aria_kernel.agent_eval.sample_shadow_raw_findings (24h SHADOW raw-findings escalation, threshold 5)",
        "aria_kernel.tool_registry.transition_tool (SHADOW->ACTIVE gate)",
        "aria_kernel.evidence_validator and aria_kernel.agent_contract / agent_compliance (envelope and evidence rules)"
      ],
      "surfaces_read_for_orientation_outside_allowed_scope_not_cited": [
        "tools/aria-adapters/doc-staleness-adapter.ts (rule definition: PATH_PREFIXES, candidateRef, finding id and message)",
        "tools/aria-adapters/doc-staleness-adapter.tool.json (status SHADOW, declared_scope docs/**/*.md)",
        "tools/aria-poc/ci_executor.py (envelope extraction and identity injection, read only for the response format)"
      ],
      "working_tree_probes_not_evidence": "existence probes (Glob) for the 67 distinct referenced paths in the request worktree, summarised in evidence_slice_analysis"
    },
    "queue_item": {
      "candidate_tools": [
        "doc-staleness-adapter"
      ],
      "pressure_id": "pressure:shadow-raw-delta:doc-staleness-adapter",
      "queue_item_id": "qi-557f4d446e57",
      "recommended_action": "sample and judge increased SHADOW findings before calibration",
      "resolution": "projected",
      "source_cycle_id": "cyc-20260918T153436Z-auto",
      "tool_status_at_projection": "SHADOW (tool manifest read for orientation, not cited as evidence)"
    },
    "runtime_attempt_ledger_hash": "sha256:52fa2021014d8a04660ca20d8e7869dd149f5ecfc08f6772c7a2559cee435db0",
    "teaching_note": {
      "downstream_surfaces": [
        "pressure queue ranking (shadow_raw_delta source weight 50, calibrated per source from the feedback ledger)",
        "judgment pipeline rows: judgment_samples, ai_judge, ai_consensus, arbiter votes",
        "adapter precision_history / auto-promote token / panel approval + veto window",
        "rule_health quarantine of the rule",
        "future implementation PRs that would cite the finding text as their premise"
      ],
      "evidence_that_proves_the_result": [
        "judgment_samples row for tool_id doc-staleness-adapter whose items come from the delta and cover every stratum present",
        "ai_judge rows from at least two distinct judge_id per judgment group, ai_consensus rows, arbiter rows where the pair split",
        "a governance row carrying the pinned reading of the rule and the per-doc count cross-check (both tables)",
        "a precision_history row whose inputs reference those consensus rows, dated after them",
        "the next shadow_raw_delta pressure for this tool scored with calibrated weights, and qi-557f4d446e57 consumed with an outcome rather than replayed"
      ],
      "what_breaks_if_skipped": "The raw delta keeps being scored at the uncalibrated shadow_raw_delta source weight and re-ranks the pressure queue every night; judge envelopes minted without a rubric split or die unclaimed, consensus starves, and the tool either never leaves SHADOW or is promoted on a number that means nothing. A promoted rule then publishes 'no longer exists' about paths that never existed, and any ARIA doc-fix PR minted from such a finding edits a plan document on a false premise.",
      "what_must_be_done": "Treat the +delta as unjudged raw signal, not as findings. Before anyone calibrates on it: (1) work out which references are new since the previous run, (2) confirm the adapter counted what an independent reader counts on the same docs, (3) decide in writing what the rule actually claims, (4) have two independent judges vote per sampled reference under that one rubric, (5) let calibration read only consensus-backed rows. Then close the queue item with the recorded reading and precision.",
      "why_it_matters": "doc-staleness-adapter is in SHADOW. The only exit is measured precision at or above the tool's threshold (0.85 default) with zero critical false positives and valid evidence chains, under operator, panel or verified auto-promote authority. Precision is computed from judged rows, so a delta calibrated before it is judged, or judged under two different readings of the rule, records a number that does not describe the rule. On the evidence slice the number moves from about 0.06-0.35 to 1.0 purely with the reading: 20 of the 31 unresolved references are lines a plan document marks YEN\u0130 (Turkish: new) -- paths that never existed -- and the adapter's finding text says they 'no longer exist'."
    }
  },
  "evidence_refs": [
    "docs/HMI_TRANSFORMATION_PLAN.md:518",
    "docs/HMI_TRANSFORMATION_PLAN.md:519",
    "docs/HMI_TRANSFORMATION_PLAN.md:520",
    "docs/HMI_TRANSFORMATION_PLAN.md:592",
    "docs/HMI_TRANSFORMATION_PLAN.md:665",
    "docs/HMI_TRANSFORMATION_PLAN.md:666",
    "docs/HMI_TRANSFORMATION_PLAN.md:877",
    "docs/HMI_TRANSFORMATION_PLAN.md:878",
    "docs/HMI_TRANSFORMATION_PLAN.md:879",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:37",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:38",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:58",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:73",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:74",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:75",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:90",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:109",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:110",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:143",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:161",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:175",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:222",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:223",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:254",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:269",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:270",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:271",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:285",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:286",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:321",
    "docs/SCADA_BUILDER_WIRING.md:113",
    "docs/DEPLOY.md:83",
    "docs/DEPLOY.md:89",
    "docs/PID_SIMULATOR.md:659",
    "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:208",
    "docs/SCADA_BUILDER_WIRING.md:23",
    "docs/admin-panel-triangle-audit/2026-05-20/admin-billing/implementation-record.md:27",
    "docs/admin-panel-triangle-audit/2026-05-21/admin-billing-runtime-contract/README.md:28",
    "docs/admin-panel-triangle-audit/2026-05-22/admin-security/README.md:22",
    "docs/LORAWAN_API.md",
    "docs/LORAWAN_ARCHITECTURE.md",
    "docs/LORAWAN_SETUP.md",
    "docs/SCADA.md",
    "docs/SCADA_EDGE_DEPLOY.md",
    "docs/SCADA_SIMULATION_MODE.md",
    "docs/admin-panel-triangle-audit/2026-05-20/README.md",
    "docs/admin-panel-triangle-audit/2026-05-20/decision-record.md",
    "docs/admin-panel-triangle-audit/2026-05-20/findings.md",
    "docs/admin-panel-triangle-audit/2026-05-20/implementation-log.md",
    "docs/admin-panel-triangle-audit/2026-05-20/out-of-scope-observations.md",
    "docs/admin-panel-triangle-audit/2026-05-20/validation.md"
  ],
  "request_id": "AIR-aria-autonomy-planner-310a6c39c90e",
  "role": "maintenance_utility",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "docs/HMI_TRANSFORMATION_PLAN.md:518",
        "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:37",
        "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:161",
        "docs/SCADA_BUILDER_WIRING.md:113",
        "docs/DEPLOY.md:83",
        "docs/FUXA_GAP_IMPLEMENTATION_PLAN.md:208"
      ],
      "id": "queue_item_projected",
      "note": "Queue item qi-557f4d446e57 is resolved into a concrete next-cycle projection (details.projection): derive the +delta finding set of doc-staleness-adapter for cycle cyc-20260918T153436Z-auto keyed by (doc path, referenced path); cross-check the adapter's per-doc missingRefs against the planner's independent read of the 20-doc evidence slice (72 repo-path spans checked, 31 unresolved in the request worktree: HMI_TRANSFORMATION_PLAN 9, FUXA_GAP_IMPLEMENTATION_PLAN 21, SCADA_BUILDER_WIRING 1, the other 17 docs 0); pin the rule's claim semantics before any judge votes, because the 31 split into plan-declared new paths marked YEN\u0130 (20), plan paths realized elsewhere (9) and references that existed and are gone (2), so measured precision is roughly 0.06-0.35 under a staleness reading and 1.0 under a non-resolution reading, on either side of the 0.85 SHADOW->ACTIVE bar; then stratified two-judge sampling with consensus, and only after that may precision_history, weight calibration or promotion readiness consume this run. The doc:line refs are the evidence; the existence verdicts are a planner working-tree probe (unverified grade) that the judge lane re-verifies at the run snapshot SHA.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
