{
  "$schema": "aria/agent-response/v1",
  "request_id": "AIR-aria-autonomy-planner-62e84bb46469",
  "claim_id": "claim_e873e4dbfee34367",
  "agent_id": "ci-executor:zcode-manual-20261008",
  "role": "maintenance_utility",
  "status": "submitted",
  "satisfaction_matrix": [
    {
      "id": "queue_item_projected",
      "verdict": "satisfied",
      "note": "Queue item qi-aa7b6e4643cd projects onto the next cycle as a continued SHADOW run of typeorm-entity-schema-adapter across the ai-service migration surface. All five migrations named by the pressure evidence resolve at the repository HEAD this response is graded against (5b35da99160cb0ddf98455dc67fdaf7563596aed), so the drift-check surface is present and current. The adapter is registered, not quarantined; its newest health decision is CALIBRATE with a 0.0 crash rate and zero ai_consensus_judged samples, so the projection keeps execution in SHADOW and names the calibration gap: judged samples must accumulate before any ACTIVE promotion is requested. No blocked condition exists for this item.",
      "evidence_refs": [
        "apps/ai-service/src/database/migrations/1800000000000-Baseline.ts",
        "apps/ai-service/src/database/migrations/1800100000000-CreateAiOutbox.ts",
        "apps/ai-service/src/database/migrations/1801000000000-EnsureAiTenantErasureProofLedger.ts",
        "apps/ai-service/src/database/migrations/1802000000000-AddByokTenantAiCredentials.ts",
        "apps/ai-service/src/database/migrations/1802100000000-CreateConversationTurns.ts"
      ]
    }
  ],
  "evidence_refs": [
    "apps/ai-service/src/database/migrations/1800000000000-Baseline.ts",
    "apps/ai-service/src/database/migrations/1800100000000-CreateAiOutbox.ts",
    "apps/ai-service/src/database/migrations/1801000000000-EnsureAiTenantErasureProofLedger.ts",
    "apps/ai-service/src/database/migrations/1802000000000-AddByokTenantAiCredentials.ts",
    "apps/ai-service/src/database/migrations/1802100000000-CreateConversationTurns.ts"
  ],
  "details": {
    "summary": "Projection for qi-aa7b6e4643cd: continue TypeORM schema drift checks in SHADOW next cycle; calibration gap recorded.",
    "queue_projection": {
      "queue_item_id": "qi-aa7b6e4643cd",
      "pressure_id": "pressure:migration-surface-repeat:repetition",
      "decision": "continue",
      "adapter": "typeorm-entity-schema-adapter",
      "adapter_status": "SHADOW",
      "adapter_health_decision": "CALIBRATE",
      "graded_head_sha": "5b35da99160cb0ddf98455dc67fdaf7563596aed",
      "next_cycle_action": "run typeorm-entity-schema-adapter in SHADOW over the five ai-service migrations",
      "calibration_gap": "ai_consensus_judged_samples=0; accumulate judged samples before requesting ACTIVE promotion"
    },
    "agent_dispatch_model": "zcode-glm-5.3",
    "executor": "manual-zcode-continuation-rescue"
  }
}
