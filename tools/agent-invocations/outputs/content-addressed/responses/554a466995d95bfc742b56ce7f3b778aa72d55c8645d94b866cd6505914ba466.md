{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-35548193228",
  "claim_id": "claim_f6668a8e363671e1",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:3564b263b330e93ff2082753794387c30c6b9e382802878d171ad0ceaf311460",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-autonomy-planner",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-autonomy-planner-28494b3f855a\",\n  \"claim_id\": \"<injected-by-executor>\",\n  \"agent_id\": \"aria-autonomy-planner\",\n  \"role\": \"maintenance_utility\",\n  \"status\": \"submitted\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"queue_item_projected\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"qi-62d7089be6e3 resolves to a 12-file judged sample drawn from the 20 evidence refs (3 candidate true test gaps, 9 candidate false positives, 3 of those imported by a spec inside the same sample) plus the judge pair, the arbitration gate and the calibration decision table the kernel mints next cycle. Calibration of test-gap-adapter is gated on the arbiter verdict over this sample, never on the raw finding delta.\",\n      \"evidence_refs\": [\n        \"apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:38\",\n        \"apps/admin-api-service/src/analytics/controllers/reports.controller.ts:59\",\n        \"apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:7\",\n        \"apps/admin-api-service/jest.config.ts:12\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \"apps/admin-api-service/jest.config.ts\",\n    \"apps/admin-api-service/jest.config.ts:12\",\n    \"apps/admin-api-service/jest.config.ts:13\",\n    \"apps/admin-api-service/src/__tests__/api/error-format.spec.ts\",\n    \"apps/admin-api-service/src/__tests__/api/error-format.spec.ts:39\",\n    \"apps/admin-api-service/src/__tests__/api/swagger.spec.ts\",\n    \"apps/admin-api-service/src/__tests__/api/swagger.spec.ts:25\",\n    \"apps/admin-api-service/src/__tests__/api/versioning.spec.ts\",\n    \"apps/admin-api-service/src/__tests__/api/versioning.spec.ts:20\",\n    \"apps/admin-api-service/src/__tests__/contract-validation.spec.ts\",\n    \"apps/admin-api-service/src/__tests__/contract-validation.spec.ts:235\",\n    \"apps/admin-api-service/src/__tests__/security/sliding-window.spec.ts\",\n    \"apps/admin-api-service/src/__tests__/security/sliding-window.spec.ts:1\",\n    \"apps/admin-api-service/src/__tests__/security/throttler-guard.spec.ts\",\n    \"apps/admin-api-service/src/__tests__/security/throttler-guard.spec.ts:1\",\n    \"apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts\",\n    \"apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:7\",\n    \"apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:94\",\n    \"apps/admin-api-service/src/analytics/analytics.module.ts\",\n    \"apps/admin-api-service/src/analytics/analytics.module.ts:25\",\n    \"apps/admin-api-service/src/analytics/controllers/analytics.controller.ts\",\n    \"apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:38\",\n    \"apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:141\",\n    \"apps/admin-api-service/src/analytics/controllers/dto/reports.dto.ts\",\n    \"apps/admin-api-service/src/analytics/controllers/dto/reports.dto.ts:21\",\n    \"apps/admin-api-service/src/analytics/controllers/index.ts\",\n    \"apps/admin-api-service/src/analytics/controllers/reports.controller.ts\",\n    \"apps/admin-api-service/src/analytics/controllers/reports.controller.ts:59\",\n    \"apps/admin-api-service/src/analytics/controllers/reports.controller.ts:399\",\n    \"apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts\",\n    \"apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts:99\",\n    \"apps/admin-api-service/src/analytics/entities/external/index.ts\",\n    \"apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts\",\n    \"apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts:25\",\n    \"apps/admin-api-service/src/analytics/entities/external/subscription.entity.ts\",\n    \"apps/admin-api-service/src/analytics/entities/external/subscription.entity.ts:46\",\n    \"apps/admin-api-service/src/analytics/entities/external/tenant.entity.ts\",\n    \"apps/admin-api-service/src/analytics/entities/external/tenant....",
    "boundaries": {
      "done_here": "Sample partitioned at file:line, judge pair and arbitration projected, calibration decision table and stop condition stated.",
      "not_done_here": "No judgment with finality, no adapter change, no dispatch, no write outside the expected output path. The kernel mints the projected items; the judges decide; the arbiter computes; the calibration decision follows its table."
    },
    "calibration_hypotheses_for_judges": [
      {
        "claim": "The raw delta is driven by declarative files (barrels, modules, synchronize:false entity mirrors).",
        "id": "H1",
        "if_confirmed": "Heuristic noise: fix the adapter's scope rule (exclude declarative classes; require a behavior-bearing predicate such as at least one function or method body), Tier 2."
      },
      {
        "claim": "The delta includes files a sample spec imports (bucket C1).",
        "id": "H2",
        "if_confirmed": "Coverage-relation defect: fix the relation and add a fixture asserting a spec-imported file is never flagged, Tier 3. No threshold change is admissible while H2 holds."
      },
      {
        "claim": "The delta counts synthetic-controller specs or library-subject specs as orphan tests.",
        "id": "H3",
        "if_confirmed": "Classification error: framework-contract and library-subject specs are excluded from the orphan-spec count by rule."
      },
      {
        "claim": "The delta reflects the two real controller gaps (bucket A).",
        "id": "H4",
        "if_confirmed": "True signal; the adapter retains value beyond jest's global threshold and the SHADOW clock continues."
      }
    ],
    "candidate_tools": [
      "test-gap-adapter"
    ],
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 174080,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 174080,
      "cache_read_input_tokens": 2089617,
      "inference_geo": "not_available",
      "input_tokens": 26,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 2652,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 2652,
          "cache_read_input_tokens": 200625,
          "input_tokens": 2,
          "output_tokens": 18960,
          "type": "message"
        }
      ],
      "output_tokens": 45250,
      "output_tokens_details": {
        "thinking_tokens": 28121
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "explanation": {
      "downstream_surface": "The adapter's scope/rule declaration under the request's allowed_scope (aria-tools/** or .claude/**, exact owner resolved by the kernel tool registry), the calibration ledger entry for test-gap-adapter, the SHADOW-to-ACTIVE decision for that adapter, and the goldset fixture set for the tool. No application code is touched by this item.",
      "evidence_that_proves_result": "Two judge envelopes with per-file verdicts each anchored at file:line inside the 20 evidence refs; one arbiter verdict computing precision on the 12-file sample; one calibration ledger row citing that verdict by ledger hash; and a same-SHA replay of the adapter whose gap set equals the judged true-positive set.",
      "what_breaks_if_skipped": "Two silent failure modes. (a) The adapter is promoted with barrel, module and entity-mirror rows counted as gaps: on this sample that is 9 of 12, precision far under the 0.85 ACTIVE bar, and the operator sees a flood of false gaps (SPEC 10.4 escalation: findings over 50 percent false positive). (b) The threshold is raised to hide that noise, and the two real gaps, two 400-500 line controllers carrying security-relevant validation with zero behavioral tests, are suppressed together with it. Either way the one signal jest's global threshold cannot see is lost.",
      "what_must_be_done": "Take the 12 non-spec files the SHADOW test-gap-adapter looked at in admin-api-service/analytics, decide per file whether 'no test exercises this' is both TRUE and WORTH REPORTING, have the evidence judge and the adversarial judge confirm independently, let the arbiter compute precision on the sample, and only then let the kernel touch the adapter's calibration. The 7 spec files and jest.config.ts are the coverage context the judges apply; they are not themselves candidates.",
      "why_it_matters": "SHADOW exists to measure an adapter's precision before its output becomes findings. The raw count rose between cycles; a count says nothing about whether the new rows are real. Calibrating on the count (threshold tweak or promotion) bakes whatever noise produced the delta into the adapter permanently."
    },
    "incidental_observations_not_part_of_this_item": [
      {
        "evidence_refs": [
          "apps/admin-api-service/src/__tests__/contract-validation.spec.ts:404",
          "apps/admin-api-service/src/analytics/analytics.module.ts:5"
        ],
        "observation": "contract-validation.spec.ts KNOWN_EXCEPTIONS explains several /analytics/* frontend routes with 'Backend returns mock data from analytics service' (L401-436) while analytics.module.ts states 'NO MOCK DATA' (L5). Two repository statements disagree; route to the contradiction ledger for investigation, single-pair evidence, no conclusion drawn here."
      }
    ],
    "pressure_id": "pressure:shadow-raw-delta:test-gap-adapter",
    "projected_queue_items": [
      {
        "depends_on": [],
        "id": "qi-62d7089be6e3.judge.evidence",
        "kind": "agent_invocation",
        "mint_requirements": [
          "Attach the adapter's per-file finding rows for cyc-20260918T153436Z-auto as request data; this envelope carries the file sample, not the adapter's rows, and without them the judge can only grade the planner's partition instead of the adapter.",
          "evidence_refs = the same 20 files; read order as listed."
        ],
        "output_contract": "details.sample_verdicts[]: {path, adapter_flagged: bool, verdict: TP | FP | not_flagged, evidence_refs: [path:line]}; details.hypotheses: {H1..H4: supported | refuted | undetermined}.",
        "questions": [
          "Per candidate file: does any spec in the sample exercise its behavior (import plus invocation), and is the file behavior-bearing?",
          "Per adapter row: does the row match the a_priori bucket; if not, which side is wrong and at which line?"
        ],
        "role": "evidence_judgment",
        "target_agent": "aria-evidence-judge"
      },
      {
        "depends_on": [],
        "id": "qi-62d7089be6e3.judge.adversarial",
        "kind": "agent_invocation",
        "mint_requirements": [
          "Same attachments as the evidence judge; read the 20 refs in REVERSE order; no sight of the evidence judge's envelope."
        ],
        "output_contract": "Same shape as the evidence judge, plus details.refutations[]: {target, outcome: refuted | stands, evidence_refs}.",
        "refutation_targets": [
          "Refute bucket A: find any spec in admin-api-service (beyond the 20-file sample) that imports AnalyticsController or ReportsController, or a supertest mount of either. The sample is not the universe.",
          "Refute bucket B/C: find behavior in the declarative files worth a unit test (candidate: DecimalTransformer usage at invoice.entity.ts L46-55).",
          "Refute the C1 classification: show that a file imported by reports-caching.spec.ts L7-16 is nonetheless unexercised (import without invocation)."
        ],
        "role": "adversarial_judgment",
        "target_agent": "aria-adversarial-judge"
      },
      {
        "computation": "precision = agreed_TP / (agreed_TP + agreed_FP) over the rows the adapter actually flagged; critical_fp = any FP on a security- or tenant-relevant path; measurement_defect = any C1 file flagged",
        "depends_on": [
          "qi-62d7089be6e3.judge.evidence",
          "qi-62d7089be6e3.judge.adversarial"
        ],
        "gate": "two unique judges, per-file verdict agreement, mean confidence at least 0.80; otherwise emit uncertainty and return the item to the queue with a widened sample (next batch of files from the delta) instead of proceeding to calibration",
        "id": "qi-62d7089be6e3.arbitrate",
        "kind": "agent_invocation",
        "output_contract": "details.calibration_input: {precision, critical_fp_count, measurement_defect: bool, hypotheses_supported: [...], judged_tp_set: [paths], judged_fp_set: [paths]}",
        "role": "consensus_arbitration",
        "target_agent": "aria-consensus-arbiter"
      },
      {
        "decision_table": [
          {
            "then": "adapter coverage-relation fix plus fixture (Tier 3); no threshold or promotion change; re-run shadow on the same SHA.",
            "when": "measurement_defect = true (any C1 file flagged)"
          },
          {
            "then": "scope-rule change in the adapter declaration under allowed_scope (Tier 2); re-run shadow on the same SHA; expected gap set == judged_tp_set.",
            "when": "precision < 0.85 and FPs concentrate in declarative classes"
          },
          {
            "then": "no rule change; SHADOW clock continues; judged sample seeds the goldset (qi-62d7089be6e3.goldset).",
            "when": "precision >= 0.85 and critical_fp_count = 0"
          },
          {
            "then": "item returns to the next-cycle queue with a widened sample; calibration untouched.",
            "when": "judges disagree or arbiter emits uncertainty"
          }
        ],
        "depends_on": [
          "qi-62d7089be6e3.arbitrate"
        ],
        "forbidden_moves": [
          "raising the adapter's reporting threshold to absorb declarative-file noise",
          "promoting on the raw count",
          "any suppression of the two bucket-A controllers"
        ],
        "id": "qi-62d7089be6e3.calibrate",
        "kind": "calibration_decision",
        "owner": "kernel (autonomy_orchestrator)",
        "preconditions": [
          "arbiter verdict present and not uncertainty",
          "the open genesis adjudication for shadow_run:test-gap-adapter is folded before any promotion past SHADOW (decision memory, not evidence)"
        ]
      },
      {
        "depends_on": [
          "qi-62d7089be6e3.arbitrate"
        ],
        "id": "qi-62d7089be6e3.goldset",
        "kind": "agent_invocation",
        "note_on_gating": "Operator-gated promotion per the judge and consensus flow; the judged TP/FP rows become fixtures for test-gap-adapter so later calibration is deterministic. The tool bar is at least 20 TP and 10 FP; this sample contributes at most 3 TP and 9 FP, so the goldset stays open after it.",
        "role": "goldset_curation",
        "target_agent": "aria-goldset-curator"
      }
    ],
    "queue_item_id": "qi-62d7089be6e3",
    "recommended_action_received": "sample and judge increased SHADOW findings before calibration",
    "resolution": "projected",
    "risks": [
      {
        "id": "R1",
        "risk": "Five judge requests for other items died ANCHOR_STALE unclaimed on 2026-09-18. Mint the judge pair only when the executor lane can claim inside the anchor window; otherwise the sample must be re-anchored at the new SHA and the a_priori partition re-verified.",
        "source": "decision_memory_not_evidence"
      },
      {
        "id": "R2",
        "risk": "genesis:3050709fb0380795 (capability gap shadow_run:test-gap-adapter) is an open HUMAN_REQUIRED; no promotion past SHADOW is admissible before the panel folds it, regardless of measured precision.",
        "source": "decision_memory_not_evidence"
      },
      {
        "id": "R3",
        "risk": "The request carries the file sample but not the adapter's per-file rows. If the kernel mints the judges without attaching those rows, the judgment measures the planner's partition, not the adapter, and the calibration input is void.",
        "source": "this_envelope"
      },
      {
        "id": "R4",
        "risk": "Bucket A rests on the absence of an exercising spec inside the 20-file sample. A spec elsewhere in admin-api-service could refute it; the adversarial judge's first refutation target exists for that reason.",
        "source": "this_envelope"
      }
    ],
    "runtime_attempt_ledger_hash": "sha256:d3f18b7e4fed2987ba727453bfa362df7e8a9c2aba47279cd42299617284cd72",
    "sample": {
      "a_priori_tally": {
        "a_priori_precision_if_adapter_flagged_all_12": "3/12 = 0.25, under the 0.85 ACTIVE bar (SPEC section 4, Engine 4); the judges confirm or refute per file before this number means anything",
        "false_positive": 4,
        "false_positive_leaning": 2,
        "must_not_be_flagged": 3,
        "true_positive": 2,
        "true_positive_dependent": 1
      },
      "candidate_count": 12,
      "context_count": 8,
      "items": [
        {
          "a_priori": "true_positive",
          "basis": "Behavior-bearing: validateDataPoints (L38-48), parsePeriodParameter with the shorthand regex (L56-85, L63), parseRangeParameter (L87-124), aggregateTimeSeriesPoints (L141-164), twenty route handlers (L179-421) including the ISO-date validation at L403-411. The only sample spec that imports analytics production code is reports-caching.spec.ts (L7-16) and it does not import this controller. contract-validation.spec.ts reads controllers as text to extract routes (L235-279): structural, not behavioral coverage.",
          "bucket": "A_behavior_no_exercising_spec",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:38",
            "apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:56",
            "apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:87",
            "apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:141",
            "apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:403",
            "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:7",
            "apps/admin-api-service/src/__tests__/contract-validation.spec.ts:235"
          ],
          "observations_for_judges_single_evidence_unconfirmed": [
            "aggregateTimeSeriesPoints keeps the LAST point per week/month bucket (L160 buckets.set with value: point.value): exact for level metrics, lossy for per-period flow metrics. It is applied to the revenue trend at L334-340. No test pins which semantics is intended; the gap hides a semantic ambiguity, which raises the value of closing it.",
            "getApiCallsTrend and getErrorRateTrend (L355-369) pass dataPoints straight through, unlike L219, L234, L269, L298 which route through validateDataPoints; the DoS-guard rationale at L35-37 does not reach these two routes. Untested inconsistency."
          ],
          "path": "apps/admin-api-service/src/analytics/controllers/analytics.controller.ts"
        },
        {
          "a_priori": "true_positive",
          "basis": "Behavior-bearing and security-relevant: sanitizeFilename (L59-65, Content-Disposition header-injection fix) applied at L187, L433, L447, L474, L518; runtime reportType/format allow-lists (L399-414); exportCsv type switch (L492-508); date validation (L147-160, L245-255). reports-caching.spec.ts exercises ReportsService only (L94, L173, L479, L546) and never this controller.",
          "bucket": "A_behavior_no_exercising_spec",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/controllers/reports.controller.ts:59",
            "apps/admin-api-service/src/analytics/controllers/reports.controller.ts:147",
            "apps/admin-api-service/src/analytics/controllers/reports.controller.ts:245",
            "apps/admin-api-service/src/analytics/controllers/reports.controller.ts:399",
            "apps/admin-api-service/src/analytics/controllers/reports.controller.ts:492",
            "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:94"
          ],
          "observations_for_judges_single_evidence_unconfirmed": [
            "exportPdf (L452-477) lacks the reportType allow-list that downloadReport carries at L402-408; the invalid value reaches generateReport, which reports-caching.spec.ts L415-424 shows rejects with BadRequestException, so the outcome is consistent but the asymmetry is untested.",
            "L32 (six class-validator decorators) and L43 (ReportSchedule) are imported and not used in the controller body after the DTOs moved to dto/reports.dto.ts (that file, L1-8). Unused-import class: route to the lint pressure, not to this test-gap item."
          ],
          "path": "apps/admin-api-service/src/analytics/controllers/reports.controller.ts"
        },
        {
          "a_priori": "true_positive_dependent",
          "basis": "Validation decorators (L21-173) execute only through ValidationPipe on a controller request; no sample spec mounts ReportsController. The closing test belongs with reports.controller.ts (a supertest/ValidationPipe controller spec); a standalone DTO spec would not exercise the pipe wiring. Judges should count this as ONE gap together with reports.controller.ts, not two.",
          "bucket": "A_behavior_no_exercising_spec",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/controllers/dto/reports.dto.ts:1",
            "apps/admin-api-service/src/analytics/controllers/dto/reports.dto.ts:21",
            "apps/admin-api-service/src/analytics/controllers/dto/reports.dto.ts:125"
          ],
          "path": "apps/admin-api-service/src/analytics/controllers/dto/reports.dto.ts"
        },
        {
          "a_priori": "false_positive",
          "basis": "Declarative @Module wiring (L25-44); the only member is the moduleName property (L46). DI composition is proven by application bootstrap, not by a unit spec. A gap row here is heuristic noise.",
          "bucket": "B_declarative",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/analytics.module.ts:25",
            "apps/admin-api-service/src/analytics/analytics.module.ts:46"
          ],
          "path": "apps/admin-api-service/src/analytics/analytics.module.ts"
        },
        {
          "a_priori": "false_positive",
          "basis": "Barrel re-export only (L5-6). No behavior exists to test.",
          "bucket": "B_declarative",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/controllers/index.ts:5"
          ],
          "path": "apps/admin-api-service/src/analytics/controllers/index.ts"
        },
        {
          "a_priori": "false_positive",
          "basis": "Barrel re-export only (L5).",
          "bucket": "B_declarative",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/entities/index.ts:5"
          ],
          "path": "apps/admin-api-service/src/analytics/entities/index.ts"
        },
        {
          "a_priori": "false_positive",
          "basis": "Barrel re-export only (L9-12). Note for calibration: if the adapter marks this barrel covered while marking the two sibling barrels uncovered, its coverage relation is import-path dependent (a spec that happens to import via the barrel), which is a heuristic artifact rather than a coverage fact.",
          "bucket": "B_declarative",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/entities/external/index.ts:9"
          ],
          "path": "apps/admin-api-service/src/analytics/entities/external/index.ts"
        },
        {
          "a_priori": "false_positive_leaning",
          "basis": "Read-only mirror of a billing-owned table: @Entity('invoices', { schema: 'billing', synchronize: false }) at L25. The only behavior-adjacent element is DecimalTransformer on four columns (L46-55), a library class. The correctness contract of a mirror is column/schema parity with the owning service, which is an invariant/drift concern, not a unit-spec concern. Judges decide whether the adapter should treat synchronize:false mirrors as outside its gap set.",
          "bucket": "C2_entity_mirror_not_imported_by_sample_spec",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts:25",
            "apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts:46"
          ],
          "path": "apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts"
        },
        {
          "a_priori": "false_positive_leaning",
          "basis": "Same shape as invoice.entity.ts: @Entity('subscriptions', { schema: 'billing', synchronize: false }) at L46; PlanTier sourced from @platform/event-contracts at L16. No sample spec imports it.",
          "bucket": "C2_entity_mirror_not_imported_by_sample_spec",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/entities/external/subscription.entity.ts:16",
            "apps/admin-api-service/src/analytics/entities/external/subscription.entity.ts:46"
          ],
          "path": "apps/admin-api-service/src/analytics/entities/external/subscription.entity.ts"
        },
        {
          "a_priori": "must_not_be_flagged",
          "basis": "Imported by reports-caching.spec.ts at L8-12 (AnalyticsSnapshot, ReportDefinition, ReportExecution) and provided as repository tokens at L133, L137, L147. If the adapter's rows flag this file, the coverage relation is defective (measurement bug), a different failure class from heuristic noise.",
          "bucket": "C1_imported_by_sample_spec",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts:99",
            "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:8",
            "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:133"
          ],
          "path": "apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts"
        },
        {
          "a_priori": "must_not_be_flagged",
          "basis": "Imported by reports-caching.spec.ts at L13 (TenantReadOnly, TenantStatus, TenantPlan) and used in the mock factory at L29-40 and the repository token at L134.",
          "bucket": "C1_imported_by_sample_spec",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/entities/external/tenant.entity.ts:23",
            "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:13",
            "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:29"
          ],
          "path": "apps/admin-api-service/src/analytics/entities/external/tenant.entity.ts"
        },
        {
          "a_priori": "must_not_be_flagged",
          "basis": "Imported by reports-caching.spec.ts at L14 (UserReadOnly) and provided as a repository token at L135.",
          "bucket": "C1_imported_by_sample_spec",
          "evidence_refs": [
            "apps/admin-api-service/src/analytics/entities/external/user.entity.ts:19",
            "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:14",
            "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:135"
          ],
          "path": "apps/admin-api-service/src/analytics/entities/external/user.entity.ts"
        }
      ],
      "selection_rule": "Every non-spec, non-config file in the request's evidence_refs is a candidate (12). Every *.spec.ts plus jest.config.ts is coverage context (8). Spec-to-source coverage is read from import statements and from static file reads inside the spec, both at file:line."
    },
    "source_cycle_id": "cyc-20260918T153436Z-auto",
    "spec_context": [
      {
        "coverage_note": "The only sample spec that reaches analytics production code. It never mounts a controller.",
        "evidence_refs": [
          "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:7"
        ],
        "path": "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts",
        "production_imports": "L7-16: AuditLogService, AnalyticsSnapshot/ReportDefinition/ReportExecution, TenantReadOnly/TenantStatus/TenantPlan, UserReadOnly, AnalyticsService, ReportsService",
        "subject": "ReportsService (L94)"
      },
      {
        "coverage_note": "Framework-contract test by design; it covers no analytics file and must not be counted as an orphan spec.",
        "evidence_refs": [
          "apps/admin-api-service/src/__tests__/api/error-format.spec.ts:39"
        ],
        "path": "apps/admin-api-service/src/__tests__/api/error-format.spec.ts",
        "production_imports": "L22-23 only (Public decorator, GlobalExceptionFilter)",
        "subject": "GlobalExceptionFilter response shape via a synthetic ErrorTestController (L39-97)"
      },
      {
        "coverage_note": "Same class as error-format.spec.ts.",
        "evidence_refs": [
          "apps/admin-api-service/src/__tests__/api/swagger.spec.ts:25"
        ],
        "path": "apps/admin-api-service/src/__tests__/api/swagger.spec.ts",
        "production_imports": "L17 only (Public decorator)",
        "subject": "Swagger/OpenAPI wiring via a synthetic SwaggerTestController (L25-38)"
      },
      {
        "coverage_note": "Same class as error-format.spec.ts.",
        "evidence_refs": [
          "apps/admin-api-service/src/__tests__/api/versioning.spec.ts:20"
        ],
        "path": "apps/admin-api-service/src/__tests__/api/versioning.spec.ts",
        "production_imports": "L14 only (Public decorator)",
        "subject": "URI versioning via a synthetic TestVersioningController (L20-34)"
      },
      {
        "coverage_note": "Structural contract over every controller's decorators, not behavioral coverage of any handler. An import-based coverage relation cannot see it; a file-read-based relation would over-credit it. Judges must not credit it as behavioral coverage of analytics.controller.ts or reports.controller.ts.",
        "evidence_refs": [
          "apps/admin-api-service/src/__tests__/contract-validation.spec.ts:235",
          "apps/admin-api-service/src/__tests__/contract-validation.spec.ts:1004"
        ],
        "path": "apps/admin-api-service/src/__tests__/contract-validation.spec.ts",
        "production_imports": "none; controllers are read as text",
        "subject": "Frontend-backend route contract by static extraction (L235-279); backend route count pinned at 459 (L1004)"
      },
      {
        "coverage_note": "Lives in admin-api-service, exercises zero admin-api-service source.",
        "evidence_refs": [
          "apps/admin-api-service/src/__tests__/security/sliding-window.spec.ts:1"
        ],
        "path": "apps/admin-api-service/src/__tests__/security/sliding-window.spec.ts",
        "production_imports": "library only",
        "subject": "SlidingWindowStrategy from @aquaculture/backend-common/security (L1)"
      },
      {
        "coverage_note": "Same class as sliding-window.spec.ts.",
        "evidence_refs": [
          "apps/admin-api-service/src/__tests__/security/throttler-guard.spec.ts:1"
        ],
        "path": "apps/admin-api-service/src/__tests__/security/throttler-guard.spec.ts",
        "production_imports": "library only",
        "subject": "ThrottlerGuard from @aquaculture/backend-common/security (L1)"
      },
      {
        "coverage_note": "L12 collectCoverageFrom over src/**/*.ts; L13 coverageThreshold.global from the per-service baselines file. This is the repository's delegated coverage gate (SPEC 9.6 delegation matrix). A GLOBAL threshold can pass while one controller sits at zero, which is the only niche the adapter legitimately adds; anything the adapter reports that jest's per-file data already shows is duplication, and anything it reports on declarative files is noise.",
        "evidence_refs": [
          "apps/admin-api-service/jest.config.ts:12",
          "apps/admin-api-service/jest.config.ts:13"
        ],
        "path": "apps/admin-api-service/jest.config.ts",
        "production_imports": "n/a",
        "subject": "coverage collection and threshold"
      }
    ],
    "stop_condition": "qi-62d7089be6e3 closes when a calibration ledger row for test-gap-adapter cites the arbiter verdict by ledger hash AND a same-SHA replay of the adapter yields a gap set equal to the judged true-positive set. Until both hold, the item stays open."
  },
  "evidence_refs": [
    "apps/admin-api-service/jest.config.ts",
    "apps/admin-api-service/jest.config.ts:12",
    "apps/admin-api-service/jest.config.ts:13",
    "apps/admin-api-service/src/__tests__/api/error-format.spec.ts",
    "apps/admin-api-service/src/__tests__/api/error-format.spec.ts:39",
    "apps/admin-api-service/src/__tests__/api/swagger.spec.ts",
    "apps/admin-api-service/src/__tests__/api/swagger.spec.ts:25",
    "apps/admin-api-service/src/__tests__/api/versioning.spec.ts",
    "apps/admin-api-service/src/__tests__/api/versioning.spec.ts:20",
    "apps/admin-api-service/src/__tests__/contract-validation.spec.ts",
    "apps/admin-api-service/src/__tests__/contract-validation.spec.ts:235",
    "apps/admin-api-service/src/__tests__/security/sliding-window.spec.ts",
    "apps/admin-api-service/src/__tests__/security/sliding-window.spec.ts:1",
    "apps/admin-api-service/src/__tests__/security/throttler-guard.spec.ts",
    "apps/admin-api-service/src/__tests__/security/throttler-guard.spec.ts:1",
    "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts",
    "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:7",
    "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:94",
    "apps/admin-api-service/src/analytics/analytics.module.ts",
    "apps/admin-api-service/src/analytics/analytics.module.ts:25",
    "apps/admin-api-service/src/analytics/controllers/analytics.controller.ts",
    "apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:38",
    "apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:141",
    "apps/admin-api-service/src/analytics/controllers/dto/reports.dto.ts",
    "apps/admin-api-service/src/analytics/controllers/dto/reports.dto.ts:21",
    "apps/admin-api-service/src/analytics/controllers/index.ts",
    "apps/admin-api-service/src/analytics/controllers/reports.controller.ts",
    "apps/admin-api-service/src/analytics/controllers/reports.controller.ts:59",
    "apps/admin-api-service/src/analytics/controllers/reports.controller.ts:399",
    "apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts",
    "apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts:99",
    "apps/admin-api-service/src/analytics/entities/external/index.ts",
    "apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts",
    "apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts:25",
    "apps/admin-api-service/src/analytics/entities/external/subscription.entity.ts",
    "apps/admin-api-service/src/analytics/entities/external/subscription.entity.ts:46",
    "apps/admin-api-service/src/analytics/entities/external/tenant.entity.ts",
    "apps/admin-api-service/src/analytics/entities/external/tenant.entity.ts:23",
    "apps/admin-api-service/src/analytics/entities/external/user.entity.ts",
    "apps/admin-api-service/src/analytics/entities/external/user.entity.ts:19",
    "apps/admin-api-service/src/analytics/entities/index.ts"
  ],
  "request_id": "AIR-aria-autonomy-planner-28494b3f855a",
  "role": "maintenance_utility",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:38",
        "apps/admin-api-service/src/analytics/controllers/reports.controller.ts:59",
        "apps/admin-api-service/src/analytics/__tests__/performance/reports-caching.spec.ts:7",
        "apps/admin-api-service/jest.config.ts:12"
      ],
      "id": "queue_item_projected",
      "note": "qi-62d7089be6e3 resolves to a 12-file judged sample drawn from the 20 evidence refs (3 candidate true test gaps, 9 candidate false positives, 3 of those imported by a spec inside the same sample) plus the judge pair, the arbitration gate and the calibration decision table the kernel mints next cycle. Calibration of test-gap-adapter is gated on the arbiter verdict over this sample, never on the raw finding delta.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
