{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-35444645590",
  "claim_id": "claim_33553ab1408f738e",
  "details": {
    "absence_search_record": {
      "adjacent_directory_listing": [
        "apps/ai-service/src/health/health.resolver.ts",
        "apps/ai-service/src/health/health.controller.ts",
        "apps/ai-service/src/health/health.module.ts"
      ],
      "importers_of_HealthResolver": [
        "apps/ai-service/src/health/health.module.ts:3"
      ],
      "invariant_specs_checked_for_this_file": [
        "tests/invariants/webhook-public-paths.spec.ts",
        "tests/invariants/platform-capability-coverage.spec.ts",
        "tests/invariants/metrics-endpoint-adoption.spec.ts"
      ],
      "invariant_specs_naming_this_file": [],
      "sibling_service_health_specs_present": [
        "apps/auth-service/src/health/__tests__/health.controller.spec.ts",
        "apps/billing-service/src/health/__tests__/health.controller.spec.ts",
        "apps/farm-service/src/health/__tests__/health.controller.spec.ts",
        "apps/gateway-api/src/health/__tests__/health.controller.spec.ts",
        "apps/sensor-service/src/health/__tests__/health.controller.spec.ts",
        "apps/admin-api-service/src/health/__tests__/reliability/health-controller.spec.ts",
        "apps/event-store-service/src/health/health.controller.spec.ts",
        "libs/backend-common/src/health/__tests__/standard-health.controller.spec.ts"
      ],
      "test_files_referencing_symbol_or_path": [
        "e2e/tests/mobile/ai-action-confirm.spec.ts:68"
      ]
    },
    "agent_contract_hash": "sha256:e691c7f7c8196ae2f3624051fb0d1f2cef45d81280aaeaa90d7b901b005758b3",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-evidence-judge",
    "agent_text": "**Verdict: `true_positive` (confidence 0.88).** The excerpt matched `apps/ai-service/src/health/health.resolver.ts` on direct read (lines 1\u201312 identical; I could not recompute the sha256 on this route). I read beyond it because the excerpt was insufficient: the finding is an absence claim about tests elsewhere in the repository, which the source file alone can neither prove nor refute.\n\n**What the finding asserts, and why both halves hold**\n\n1. *Security-sensitive.* The emitting rule (`tools/aria-adapters/test-gap-adapter.ts:271-272`) classifies a file as security-sensitive when its text contains `@Public`, `AuthGuard`, `TenantGuard` or `PermissionGuard`. `health.resolver.ts:5` (`@Public()`) and `:6` (`@SkipTenantGuard()`) sit at **class scope**, so every field on `HealthResolver` \u2014 today's `aiServiceHealth` (`:9`) and any field added later \u2014 bypasses both the auth guard and the tenant guard. That is a real guard-exemption boundary, not a naming artifact.\n2. *No adjacent or importing test signal.* `apps/ai-service/src/health/` holds only the resolver, controller and module \u2014 no `__tests__/`. The sole importer of `HealthResolver` is `health.module.ts:3`. A repo-wide search of test files for `HealthResolver` / `health.resolver` / `aiServiceHealth` hits one place: `e2e/tests/mobile/ai-action-confirm.spec.ts:68`, where `aiServiceHealth` is called with an **authenticated** worker token inside `ensureTenantTable` purely to trigger tenant-clone provisioning \u2014 nothing about the response or the guard bypass is asserted, and the unauthenticated path `@Public()` opens is never exercised. No `@Public()`-aware invariant spec (`tests/invariants/webhook-public-paths.spec.ts` and siblings) names this file, and nothing in the repo feeds it to the adapter's allowlist channel (`test-gap-adapter.ts:168`).\n3. *Convention corroboration.* Every other service with `src/health/` ships an adjacent spec (`apps/auth-service/src/health/__tests__/health.controller.spec.ts`, `apps/farm-service/...`, `libs/backend-common/src/health/__tests__/standard-health.controller.spec.ts`). `ai-service` is the single service whose health surface has none; per `test-gap-adapter.ts:296-320` those sibling specs resolve to base `health.controller`, not `health`, so they match neither mechanically nor substantively.\n\n**Why it matters / what breaks if skipped.** The class-level exemption is a standing \"no auth, no tenant context\" grant on a federated GraphQL type reachable through the gateway (`aiServiceHealth` is in the generated supergraph types, `web/shared-ui/src/generated/graphql-types.ts:15286`). Nothing at build or test time pins \"this exempt resolver exposes exactly one constant field\". A future `@Query` added to `HealthResolver` that reads tenant state would ship unauthenticated and cross-tenant with every gate green.\n\n**Correct path (Tier 3 \u2014 make it detectable).** Add `apps/ai-service/src/health/__tests__/health.resolver.spec.ts` asserting (a) `aiServiceHealth()` returns `'ok'` and (b) through the same metadata keys the guards read, that `HealthResolver` carries the public + skip-tenant exemption and exposes only `aiServiceHealth`, so a new field on an exempt class fails the test. Cover `health.controller.ts` in the same change to match the sibling convention.\n\n**Tempering note.** The body is a constant-returning probe, so there is no present-day data exposure; the test's value is pinning the exemption boundary. That residual, not the adapter's severity label, is what the confidence reflects.\n\n```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-evidence-judge-b7c0c7651520\",\n  \"claim_id\": \"claim_AIR-aria-evidence-judge-b7c0c7651520\",\n  \"agent_id\": \"aria-evidence-judge\",\n  \"role\": \"evidence_judgment\",\n  \"status\": \"submitted\",\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/general/round-na-evidence_judgment-AIR-aria-evidence-judge-b7c0c7651520.md\"...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 103521,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 103521,
      "cache_read_input_tokens": 1114158,
      "inference_geo": "not_available",
      "input_tokens": 28,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 1963,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 1963,
          "cache_read_input_tokens": 113237,
          "input_tokens": 2,
          "output_tokens": 10224,
          "type": "message"
        }
      ],
      "output_tokens": 33970,
      "output_tokens_details": {
        "thinking_tokens": 25324
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "envelope_shape_refs_consulted": [
      "aria-kernel/aria_kernel/evidence_validator.py:670",
      "aria-kernel/aria_kernel/agent_contract.py:84",
      "aria-kernel/aria_kernel/judgment_bridge.py:206",
      "aria-kernel/aria_kernel/judge_fanout.py:232",
      "tools/aria-poc/ci_executor.py:2519"
    ],
    "excerpt_verification": {
      "claimed_content_hash": "sha256:3163f635a725ed84463311ac0068950245aa2d0f2576ae7a31d5b5243faddab1",
      "lines": "1-12",
      "path": "apps/ai-service/src/health/health.resolver.ts",
      "read_beyond_excerpt_because": "the finding is an absence claim about tests elsewhere in the repository, which the cited source file cannot establish on its own",
      "result": "excerpt matched the file byte-for-byte on direct read; sha256 not recomputed (no hashing tool on this route)"
    },
    "runtime_attempt_ledger_hash": "sha256:722e69a1fa9e7d26e802ad4940a1f76c667a7c10d6e75e0ad595ea61f2959932",
    "verdict": {
      "confidence": 0.88,
      "evidence_refs": [
        "apps/ai-service/src/health/health.resolver.ts:5",
        "apps/ai-service/src/health/health.resolver.ts:6",
        "apps/ai-service/src/health/health.resolver.ts:9",
        "apps/ai-service/src/health/health.module.ts:3",
        "e2e/tests/mobile/ai-action-confirm.spec.ts:68",
        "tools/aria-adapters/test-gap-adapter.ts:271",
        "tools/aria-adapters/test-gap-adapter.ts:296",
        "tools/aria-adapters/test-gap-adapter.ts:168",
        "apps/auth-service/src/health/__tests__/health.controller.spec.ts",
        "libs/backend-common/src/health/__tests__/standard-health.controller.spec.ts"
      ],
      "finding_fingerprint": null,
      "finding_id": "security-source-without-test:apps/ai-service/src/health/health.resolver.ts",
      "identity_fields_note": "run_id, judgment_group_id and finding_fingerprint are request-minted (judge_fanout.py:239-246) and were not rendered in the prompt; the bridge sources them from the request first, so they are left null here rather than echoed from a guess. prompt_hash is null because no hashing tool was available on this route.",
      "judge_id": "aria-evidence-judge",
      "judgment_group_id": null,
      "model": "claude-opus-5",
      "prompt_hash": null,
      "rationale": "Both halves of the claim verify against repo content at b8febe123. (1) Security-sensitive: the emitting rule at tools/aria-adapters/test-gap-adapter.ts:271-272 marks a file when its text contains @Public, AuthGuard, TenantGuard or PermissionGuard; health.resolver.ts:5 (@Public()) and :6 (@SkipTenantGuard()) are class-level decorators, so every field on HealthResolver, including any added later, bypasses the auth guard and the tenant guard. (2) No coverage signal: apps/ai-service/src/health/ contains only health.resolver.ts, health.controller.ts and health.module.ts with no __tests__ directory; the only importer of HealthResolver is health.module.ts:3; a repo-wide search of test files for HealthResolver, health.resolver and aiServiceHealth hits only e2e/tests/mobile/ai-action-confirm.spec.ts:68, which queries aiServiceHealth with an authenticated worker token inside ensureTenantTable to provoke tenant-clone provisioning and asserts nothing about the response or the guard bypass; the unauthenticated path @Public() opens is never exercised. No @Public()-aware invariant spec (tests/invariants/webhook-public-paths.spec.ts, platform-capability-coverage.spec.ts, metrics-endpoint-adoption.spec.ts) names this file, and nothing in the repo supplies it to the adapter allowlist channel (test-gap-adapter.ts:168). Corroboration: every sibling service with src/health/ ships an adjacent health spec (auth, billing, farm, gateway, sensor, admin-api, event-store, plus libs/backend-common standard-health); ai-service is the sole service whose health surface has none, and per matchingTests (test-gap-adapter.ts:296-320) those sibling specs resolve to base 'health.controller', not 'health', so they are no match mechanically or substantively. Impact: the class-level exemption is a standing no-auth, no-tenant grant on a federated type reachable through the gateway (web/shared-ui/src/generated/graphql-types.ts:15286); nothing at build or test time pins 'this exempt resolver exposes exactly one constant field', so a future @Query on HealthResolver that reads tenant state would ship unauthenticated and cross-tenant with every gate green. Recommended root-cause fix (Tier 3, make it detectable): add apps/ai-service/src/health/__tests__/health.resolver.spec.ts asserting aiServiceHealth() returns 'ok' and, via the metadata keys the guards read, that HealthResolver carries the public + skip-tenant exemption and exposes only aiServiceHealth, so a new field on an exempt class fails the test; cover health.controller.ts in the same change to match sibling convention. Confidence sits below 1.0 because the current body is a constant-returning probe with no present-day data exposure; the test's value is pinning the exemption boundary rather than the constant.",
      "run_id": null,
      "severity": "high",
      "tool_id": "test-gap-adapter",
      "verdict": "true_positive"
    }
  },
  "evidence_refs": [
    "apps/ai-service/src/health/health.resolver.ts",
    "apps/ai-service/src/health/health.resolver.ts:5",
    "apps/ai-service/src/health/health.resolver.ts:6",
    "apps/ai-service/src/health/health.resolver.ts:9",
    "apps/ai-service/src/health/health.module.ts:3",
    "e2e/tests/mobile/ai-action-confirm.spec.ts:68",
    "tools/aria-adapters/test-gap-adapter.ts:168",
    "tools/aria-adapters/test-gap-adapter.ts:271",
    "tools/aria-adapters/test-gap-adapter.ts:296",
    "tests/invariants/webhook-public-paths.spec.ts",
    "apps/auth-service/src/health/__tests__/health.controller.spec.ts",
    "apps/farm-service/src/health/__tests__/health.controller.spec.ts",
    "libs/backend-common/src/health/__tests__/standard-health.controller.spec.ts",
    "web/shared-ui/src/generated/graphql-types.ts:15286"
  ],
  "request_id": "AIR-aria-evidence-judge-b7c0c7651520",
  "role": "evidence_judgment",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "apps/ai-service/src/health/health.resolver.ts",
        "apps/ai-service/src/health/health.resolver.ts:5",
        "apps/ai-service/src/health/health.resolver.ts:6",
        "apps/ai-service/src/health/health.resolver.ts:9",
        "apps/ai-service/src/health/health.module.ts:3",
        "e2e/tests/mobile/ai-action-confirm.spec.ts:68",
        "tools/aria-adapters/test-gap-adapter.ts:271",
        "tools/aria-adapters/test-gap-adapter.ts:296",
        "tools/aria-adapters/test-gap-adapter.ts:168",
        "apps/auth-service/src/health/__tests__/health.controller.spec.ts",
        "apps/farm-service/src/health/__tests__/health.controller.spec.ts",
        "libs/backend-common/src/health/__tests__/standard-health.controller.spec.ts"
      ],
      "id": "verdict",
      "note": "true_positive. Security-sensitive per the emitting rule (test-gap-adapter.ts:271-272 matches @Public / TenantGuard in file text): health.resolver.ts:5 carries @Public() and :6 carries @SkipTenantGuard() at class scope, exempting every field on HealthResolver from the auth and tenant guards. No test signal: apps/ai-service/src/health/ has no __tests__ directory; the only importer of HealthResolver is health.module.ts:3; the only test referencing aiServiceHealth is e2e/tests/mobile/ai-action-confirm.spec.ts:68, which calls it with an authenticated token as a tenant-provisioning trigger and asserts nothing about the resolver or its guard bypass. Every sibling service with src/health/ ships an adjacent health spec; ai-service is the sole exception.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
