{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-35548193228",
  "claim_id": "claim_06ce8c554eb18e59",
  "details": {
    "admissibility_note": "The request's evidence payload listed only harvest.resolver.ts. The finding is an absence claim, which the source file alone cannot confirm or refute, so the additional refs above were read at the worktree snapshot inside allowed_scope '**' (forbidden_scope empty). tool_id derives from tools/aria-adapters/test-gap-adapter.ts:190-:191, which emits this finding id and rule; run_id, prompt_hash and judgment_group_id were not present in the request and are left null rather than invented.",
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:373bb9d1e1fe2dfe7c9440b3d7cbafdb45cfb204136a988d6cdfc22846098ad2",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-evidence-judge",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-evidence-judge-b9d9a4f17928\",\n  \"claim_id\": \"AIR-aria-evidence-judge-b9d9a4f17928\",\n  \"agent_id\": \"aria-evidence-judge\",\n  \"role\": \"evidence_judgment\",\n  \"status\": \"submitted\",\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/general/round-na-evidence_judgment-AIR-aria-evidence-judge-b9d9a4f17928.md\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"verdict\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"Verdict true_positive returned with file:line evidence. The resolver is security-sensitive (class-level @UseGuards(TenantGuard, MobileFeatureGuard) at :197, per-operation @Roles floors, @RequiresMobileFeature('harvest') at :354, caller roles/assignedSiteIds threaded into CreateHarvestRecordCommand at :367-:368) and no adjacent or importing test exists: the resolvers directory holds no spec, and HarvestResolver is imported only by harvest.module.ts:55. The @Roles floors are pinned by the structural permission-matrix.spec.ts scan, but the MobileFeatureGuard registration, the 'harvest' feature decorator and the site-authz context pass-through have no test at any layer.\",\n      \"evidence_refs\": [\n        \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:197\",\n        \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:353\",\n        \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:354\",\n        \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:367\",\n        \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:368\",\n        \"apps/farm-service/src/harvest/harvest.module.ts:55\",\n        \"apps/farm-service/src/harvest/harvest.module.ts:92\",\n        \"apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts:57\",\n        \"apps/farm-service/src/common/authz/resolver-scanner.ts:79\",\n        \"apps/farm-service/src/common/authz/permission-matrix.ts:84\",\n        \"apps/farm-service/src/app.module.ts:531\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:10\",\n    \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:197\",\n    \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:198\",\n    \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:213\",\n    \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:353\",\n    \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:354\",\n    \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:357\",\n    \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:367\",\n    \"apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:368\",\n    \"apps/farm-service/src/harvest/harvest.module.ts:55\",\n    \"apps/farm-service/src/harvest/harvest.module.ts:92\",\n    \"apps/farm-service/src/harvest/harvest.module.ts:110\",\n    \"apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts:57\",\n    \"apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts:98\",\n    \"apps/farm-service/src/common/authz/resolver-scanner.ts:79\",\n    \"apps/farm-service/src/common/authz/permission-matrix.ts:84\",\n    \"apps/farm-service/src/common/authz/permission-matrix.ts:113\",\n    \"apps/farm-service/src/common/authz/permission-matrix.ts:251\",\n    \"apps/farm-service/src/common/authz/permission-matrix.ts:387\",\n    \"apps/farm-service/src/common/authz/permission-matrix.ts:396\",\n    \"apps/farm-service/src/common/authz/permission-matrix.ts:397\",\n    \"apps/farm-service/src/common/authz/permission-matrix.ts:398\",\n    \"apps/farm-service/src/app.module.ts:531\",\n    \"apps/farm-service/src/app.module.ts:541\",\n    \"apps/farm-service/src/app.module.ts:566\",\n    \"apps/farm-service/src/harvest/__tests__/handlers/create-harvest-record.handler.spec.ts:211\",\n    \"tools/aria-adapters/test-gap-adapter.ts:150\",\n    \"tools/aria-adapters/test-gap-adapter.ts:190\"\n  ],\n  \"details\": {\n    \"verdict\": {\n      \"tool_id\": \"test-...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 85639,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 85639,
      "cache_read_input_tokens": 814355,
      "inference_geo": "not_available",
      "input_tokens": 28,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 1911,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 1911,
          "cache_read_input_tokens": 88590,
          "input_tokens": 2,
          "output_tokens": 9723,
          "type": "message"
        }
      ],
      "output_tokens": 35109,
      "output_tokens_details": {
        "thinking_tokens": 24958
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "excerpt_hash_check": "The excerpt content matched the file on disk line-for-line at the lines consulted (1-281 excerpt; :193-:507 read directly because the excerpt was truncated before the mutations section).",
    "explanation_for_junior_engineer": {
      "downstream_surface_affected": "farm-service GraphQL createHarvestRecord / updateHarvestRecord / deleteHarvestRecord for mobile and web callers; the SEC-HIGH-051 site-scoped authorization in CreateHarvestRecordHandler that trusts the resolver to forward the caller's assignedSiteIds.",
      "evidence_that_proves_the_result": "harvest.resolver.ts:197/:354/:367/:368 (untested security wiring); harvest.module.ts:55 and :110 (only importers, no spec); permission-matrix.spec.ts:57 + resolver-scanner.ts:79 + permission-matrix.ts:84..:398 (the structural coverage that limits the gap to the items above); app.module.ts:531/:541/:566 (MobileFeatureGuard absent from the global guard list).",
      "what_breaks_if_skipped": "Removing MobileFeatureGuard from harvest.resolver.ts:197 or the decorator at :354, or dropping user.roles / user.assignedSiteIds at :367-:368, passes the full test suite today. The regression would surface only in production as a bypassed mobile entitlement or a broken site-authz decision.",
      "what_must_be_done": "An absence claim ('no test covers this security file') cannot be decided from the cited source file alone. You enumerate the tests the adapter's heuristic looks for (adjacent spec, spec importing the class), then hunt for tests the heuristic is blind to (structural scans that read the file without importing it), then compare what those tests actually pin against the file's security-relevant lines.",
      "why_it_matters": "A HIGH true_positive mints a remediation plan; a false_positive discards the finding. Judging on the literal heuristic alone would approve a plan that re-tests the @Roles floors permission-matrix.spec.ts already owns; judging it false because a structural test exists would leave the SEC-HIGH-052 entitlement gate and the SEC-HIGH-051 context threading unpinned."
    },
    "runtime_attempt_ledger_hash": "sha256:eb5f4cd242b3cb5cb13061ab44602b066f287fe350703afd44fe11fa73e0cc90",
    "searched_scope": {
      "purpose": "Absence-claim discipline (CONTRACTS.md section 6: searched-scope record + synonym list).",
      "queries": [
        "glob apps/farm-service/**/*harvest*.{spec,test,e2e-spec}.ts -> 14 files, none is a resolver spec",
        "glob apps/farm-service/src/harvest/resolvers/* -> harvest.resolver.ts, harvest-plan.resolver.ts only",
        "grep \\bHarvestResolver\\b in *.ts -> harvest.resolver.ts:2,:198,:199 and harvest.module.ts:55,:110 only",
        "grep HarvestResolver|harvest\\.resolver in **/*.{spec,test,e2e-spec}.ts -> no matches",
        "grep createHarvestRecord|updateHarvestRecord|deleteHarvestRecord|harvestStatistics|harvestsByBatch in test files -> comments and string literals in aquamobil registry specs, create-harvest-record.input.spec.ts, create-harvest-record.handler.spec.ts, batch-harvest-eligibility.service.spec.ts, farm-domain-metrics.service.spec.ts; none instantiates or calls the resolver",
        "grep RequiresMobileFeature\\('harvest'\\)|createHarvestRecord in libs/**/*.spec.ts -> no matches",
        "grep RequiresMobileFeature|MobileFeatureGuard|assignedSiteIds in **/*.spec.ts -> 22 files, none under apps/farm-service/src/harvest/",
        "grep APP_GUARD in apps/farm-service/src -> ServiceIdentityGuard, TenantGuard, RolesGuard, ThrottlerGuard, PermissionMatrixGuard; MobileFeatureGuard absent",
        "grep MobileFeatureGuard in apps/farm-service/src -> per-resolver @UseGuards only (harvest, storage, task, feeding-program, batch, water-quality) plus module providers"
      ],
      "synonyms_checked": [
        "HarvestResolver",
        "harvest.resolver",
        "harvest/resolvers",
        "createHarvestRecord",
        "harvestsByBatch",
        "harvestStatistics",
        "RequiresMobileFeature('harvest')"
      ]
    },
    "verdict": {
      "confidence": 0.78,
      "evidence_refs": [
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:10",
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:197",
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:198",
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:353",
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:354",
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:357",
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:367",
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:368",
        "apps/farm-service/src/harvest/harvest.module.ts:55",
        "apps/farm-service/src/harvest/harvest.module.ts:92",
        "apps/farm-service/src/harvest/harvest.module.ts:110",
        "apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts:57",
        "apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts:98",
        "apps/farm-service/src/common/authz/resolver-scanner.ts:79",
        "apps/farm-service/src/common/authz/permission-matrix.ts:84",
        "apps/farm-service/src/common/authz/permission-matrix.ts:397",
        "apps/farm-service/src/app.module.ts:531",
        "apps/farm-service/src/app.module.ts:566",
        "apps/farm-service/src/harvest/__tests__/handlers/create-harvest-record.handler.spec.ts:211",
        "tools/aria-adapters/test-gap-adapter.ts:190"
      ],
      "finding_id": "security-source-without-test:apps/farm-service/src/harvest/resolvers/harvest.resolver.ts",
      "judge_id": "aria-evidence-judge",
      "judgment_group_id": null,
      "model": "claude-opus-5",
      "prompt_hash": null,
      "rationale": "Adapter claim verified both literally and on substance. (1) Security-sensitive: the resolver imports TenantGuard and MobileFeatureGuard (harvest.resolver.ts:10), applies @UseGuards(TenantGuard, MobileFeatureGuard) at class level (:197), carries per-operation @Roles floors (:213, :266, :281, :308, :353, :378, :412), gates createHarvestRecord with @RequiresMobileFeature('harvest') (:354), and threads the caller's roles and assignedSiteIds from @CurrentUser (:357) into CreateHarvestRecordCommand (:367, :368) - the SEC-HIGH-051 object-level site-authz input. (2) No adjacent or importing test: apps/farm-service/src/harvest/resolvers/ contains only harvest.resolver.ts and harvest-plan.resolver.ts (no __tests__ directory, no *.spec.ts); a repo-wide grep for HarvestResolver returns only the file itself and the module wiring at harvest.module.ts:55 and :110; a grep for HarvestResolver or harvest.resolver across every *.spec.ts / *.test.ts / *.e2e-spec.ts returns nothing; operation-name hits in tests (createHarvestRecord and siblings) are comments or metric/registry string literals inside other units' specs, not resolver exercise. (3) Boundary the fix must respect: the @Roles floors ARE already pinned by a structural security test that the adapter's adjacent-or-importing heuristic cannot see - permission-matrix.spec.ts:57 calls scanResolvers, resolver-scanner.ts:79 walks every *.resolver.ts under farm-service, permission-matrix.spec.ts:98 asserts source decorators equal the matrix, and permission-matrix.ts carries explicit entries for all seven harvest operations (:84 createHarvestRecord, :113 deleteHarvestRecord, :251 updateHarvestRecord, :387 harvest, :396 harvestStatistics, :397 harvests, :398 harvestsByBatch) that match the decorators in source. TenantGuard, RolesGuard and PermissionMatrixGuard are also global APP_GUARDs (app.module.ts:531, :541, :566), so the tenant and role floors have a runtime counterpart. (4) What remains untested at every layer and decides true_positive: MobileFeatureGuard is NOT a global guard - its only enforcement on the harvest surface is the class-level @UseGuards at :197 (provider registered at harvest.module.ts:92) together with the :354 decorator, and no test in the repository asserts either one on this resolver (the only RequiresMobileFeature/MobileFeatureGuard tests are the generic guard spec in libs/backend-common and unrelated weather/gateway specs). Deleting :197's MobileFeatureGuard or :354 silently disables the SEC-HIGH-052 harvest entitlement gate with a green test suite. Likewise the pass-through of user.roles and user.assignedSiteIds (:367, :368) has no resolver-level test: create-harvest-record.handler.spec.ts:211 exercises the handler's site authz GIVEN those inputs, not that the resolver supplies them. Recommended root-cause fix (architectural tier 3, make it detectable): add apps/farm-service/src/harvest/resolvers/__tests__/harvest.resolver.spec.ts that (a) reads the NestJS guard metadata on HarvestResolver and the mobile-feature metadata on createHarvestRecord via Reflector and asserts MobileFeatureGuard and the 'harvest' feature key are present, and (b) instantiates HarvestResolver with a mocked CommandBus and asserts createHarvestRecord dispatches a CreateHarvestRecordCommand carrying user.roles and user.assignedSiteIds from the @CurrentUser context. Do not re-test the @Roles floors (permission-matrix.spec.ts owns them) and do not close the finding through the adapter allowlist at test-gap-adapter.ts:150, which is a tier-4 escape hatch. Confidence held below 0.80 because the finding's headline overstates the gap: the dominant authorization property is already covered structurally, so an adjudicator weighting the heuristic's blind spot could call the HIGH severity noise; the untested entitlement-gate wiring and site-authz context threading are what tip the verdict to true_positive.",
      "run_id": null,
      "tool_id": "test-gap-adapter",
      "verdict": "true_positive"
    }
  },
  "evidence_refs": [
    "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:10",
    "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:197",
    "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:198",
    "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:213",
    "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:353",
    "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:354",
    "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:357",
    "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:367",
    "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:368",
    "apps/farm-service/src/harvest/harvest.module.ts:55",
    "apps/farm-service/src/harvest/harvest.module.ts:92",
    "apps/farm-service/src/harvest/harvest.module.ts:110",
    "apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts:57",
    "apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts:98",
    "apps/farm-service/src/common/authz/resolver-scanner.ts:79",
    "apps/farm-service/src/common/authz/permission-matrix.ts:84",
    "apps/farm-service/src/common/authz/permission-matrix.ts:113",
    "apps/farm-service/src/common/authz/permission-matrix.ts:251",
    "apps/farm-service/src/common/authz/permission-matrix.ts:387",
    "apps/farm-service/src/common/authz/permission-matrix.ts:396",
    "apps/farm-service/src/common/authz/permission-matrix.ts:397",
    "apps/farm-service/src/common/authz/permission-matrix.ts:398",
    "apps/farm-service/src/app.module.ts:531",
    "apps/farm-service/src/app.module.ts:541",
    "apps/farm-service/src/app.module.ts:566",
    "apps/farm-service/src/harvest/__tests__/handlers/create-harvest-record.handler.spec.ts:211",
    "tools/aria-adapters/test-gap-adapter.ts:150",
    "tools/aria-adapters/test-gap-adapter.ts:190"
  ],
  "request_id": "AIR-aria-evidence-judge-b9d9a4f17928",
  "role": "evidence_judgment",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:197",
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:353",
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:354",
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:367",
        "apps/farm-service/src/harvest/resolvers/harvest.resolver.ts:368",
        "apps/farm-service/src/harvest/harvest.module.ts:55",
        "apps/farm-service/src/harvest/harvest.module.ts:92",
        "apps/farm-service/src/common/authz/__tests__/permission-matrix.spec.ts:57",
        "apps/farm-service/src/common/authz/resolver-scanner.ts:79",
        "apps/farm-service/src/common/authz/permission-matrix.ts:84",
        "apps/farm-service/src/app.module.ts:531"
      ],
      "id": "verdict",
      "note": "Verdict true_positive returned with file:line evidence. The resolver is security-sensitive (class-level @UseGuards(TenantGuard, MobileFeatureGuard) at :197, per-operation @Roles floors, @RequiresMobileFeature('harvest') at :354, caller roles/assignedSiteIds threaded into CreateHarvestRecordCommand at :367-:368) and no adjacent or importing test exists: the resolvers directory holds no spec, and HarvestResolver is imported only by harvest.module.ts:55. The @Roles floors are pinned by the structural permission-matrix.spec.ts scan, but the MobileFeatureGuard registration, the 'harvest' feature decorator and the site-authz context pass-through have no test at any layer.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
