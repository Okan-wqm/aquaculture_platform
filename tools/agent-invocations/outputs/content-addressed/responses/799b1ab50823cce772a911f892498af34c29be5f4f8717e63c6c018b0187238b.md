{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-37713931273",
  "claim_id": "claim_eab3f336e204af06",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:b54c4a6ccd4ed9b787737a3d4382bc09b93c836064fac3dbbbbd8e81c4b46f6b",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-evidence-judge",
    "agent_text": "Verification complete. The excerpt's `content_hash` matched lines 1-159 of the file, and I read the remaining lines 160-409 plus searched the repo for any test or CI job that exercises this migration.\n\n```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-evidence-judge-062d5da63359\",\n  \"claim_id\": \"AIR-aria-evidence-judge-062d5da63359\",\n  \"agent_id\": \"aria-evidence-judge\",\n  \"role\": \"evidence_judgment\",\n  \"status\": \"submitted\",\n  \"output_path\": \"/home/gharunner/actions-runner/_work/aquaculture_platform/aquaculture_platform/.aria-state-store/tools/agent-invocations/outputs/general/round-na-evidence_judgment-AIR-aria-evidence-judge-062d5da63359.md\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"premise:1\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"Holds literally. down() issues two row deletions against live tables: line 402 deletes from \\\"feeding_protocol_assignments\\\" keyed on the createdBy sentinel, and line 406 deletes from \\\"feeding_protocols_v2\\\" by a LIKE '[migrated:%' note prefix. up() additionally reshapes live data, reading legacy feeding_programs / feeding_protocols rows and writing converted rows into feeding_protocols_v2 (line 205) and feeding_protocol_assignments (line 335). Line 41 records that the file emits no DDL, which is why its hazard is data-shaped rather than schema-shaped.\",\n      \"evidence_refs\": [\n        \"apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:402\",\n        \"apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:406\",\n        \"apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:205\",\n        \"apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:41\"\n      ]\n    },\n    {\n      \"id\": \"premise:2\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"Holds, with the nuance stated plainly: the migration IS executed against a real Postgres, because farm-service's migration chain is registered in the db-migrate bootstrap-from-scratch integration spec and replayed by runMigrations, which the Database Migration Check workflow runs in CI. That database is a fresh empty volume and its assertions are schema-existence assertions; this file emits no DDL (line 41), so on an empty database every SELECT returns zero rows, no INSERT fires, and the run proves only that the statements parse. The premise is conjunctive \u2014 runs it AND asserts its effect \u2014 and the second conjunct fails everywhere. A repo-wide search for the class name MigrateFeedingProgramsToProtocolV21806300000000 and for the 1806300000000 timestamp returns only this file, the manifest registration that loads it, and documentation; no spec imports it. The unit tests the docblock at line 22 points to cover the pure conversion lib only (describe blocks sampleMatrix, normalizeAssignmentsToRanges, convertProgramToProtocolV2, convertV1ProtocolToV2, helpers) and never construct the migration class or a QueryRunner.\",\n      \"evidence_refs\": [\n        \"apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:41\",\n        \"apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:22\"\n      ]\n    },\n    {\n      \"id\": \"defect\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"A person must add product code: a spec covering this migration, in the shape the migration's own __tests__ directory already fixes for sixteen sibling migrations including data-backfill ones, which import the migration class, drive up()/down() against a typed mock QueryRunner, and assert the emitted SQL. The uncovered behaviour is precisely the read/write plumbing the pure conversion lib cannot reach: marker-keyed idempotency, the fail-closed skip of site-less units (lines 366 and 384), the WHERE NOT EXISTS guard that must not overwrite a live operator assignment (line 342), the invariant that every migrated assignment is written paused (li...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 73619,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 73619,
      "cache_read_input_tokens": 301346,
      "inference_geo": "not_available",
      "input_tokens": 12,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 2940,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 2940,
          "cache_read_input_tokens": 75541,
          "input_tokens": 2,
          "output_tokens": 11926,
          "type": "message"
        }
      ],
      "output_tokens": 18468,
      "output_tokens_details": {
        "thinking_tokens": 11392
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "runtime_attempt_ledger_hash": "sha256:395b28d2197eb283f029825ce93930255cb93c508e3539e1c99f91503c59ea55",
    "verdict": {
      "confidence": 0.88,
      "evidence_excerpt_hash_matched": "sha256:c333f6b9bbd9bf65389cf3acaa4268425874d0592c76bc985d7f295421ba72ac",
      "evidence_refs": [
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:22",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:41",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:205",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:335",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:340",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:342",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:366",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:384",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:402",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:406"
      ],
      "finding_id": "migration-without-test:apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts",
      "judge_id": "aria-evidence-judge",
      "judgment_group_id": "AIR-aria-evidence-judge-062d5da63359",
      "model": "claude-opus-5",
      "prompt_hash": null,
      "rationale": "WHAT WAS VERIFIED. The pinned excerpt covered lines 1-159 and its content_hash matched the file at the snapshot; the excerpt was marked truncated, so I read lines 160-409, where both hazardous statements live. All three obligations were then checked against product code only.\n\nPREMISE 1 \u2014 the migration reshapes and deletes live data. up() is a data migration: it reads legacy feeding_programs and feeding_protocols rows and writes converted rows into feeding_protocols_v2 (INSERT at line 205) and feeding_protocol_assignments (INSERT at line 335). down() deletes live rows twice \u2014 line 402 from feeding_protocol_assignments by the createdBy sentinel, line 406 from feeding_protocols_v2 by the note prefix LIKE '[migrated:%'. Line 41 states the file carries no DDL, which is the reason its blast radius is data rather than schema.\n\nPREMISE 2 \u2014 nothing asserts its effect, stated with the counter-fact included. This migration is genuinely executed against a live Postgres: farm-service's migration chain is registered in the db-migrate bootstrap-from-scratch integration spec and replayed through runMigrations, and the Database Migration Check workflow runs that spec on a Postgres testcontainer in CI. That does not satisfy the premise's conjunction. The bootstrap database is a fresh empty volume and its assertions are schema-existence assertions; since this file emits no DDL, every SELECT in up() returns zero rows on that database, no INSERT fires, and the only property proved is that the statements parse and do not throw. Searching the repository for the class name and for the 1806300000000 timestamp returns the migration file, the manifest entry that registers it, and documentation \u2014 no spec imports it. The unit coverage the docblock advertises at line 22 belongs to the pure conversion lib (its describe blocks are sampleMatrix, normalizeAssignmentsToRanges, convertProgramToProtocolV2, convertV1ProtocolToV2, helpers); it never constructs the migration class and never touches a QueryRunner, so it cannot assert any read or write this file performs.\n\nDEFECT \u2014 product code must change, and the shape is already settled. The migration's own __tests__ directory holds sixteen sibling specs, including ones for data-backfill migrations, and each imports the migration class, drives up()/down() against a typed mock QueryRunner, and asserts the emitted SQL. This migration has no such spec, and what goes untested is exactly the plumbing the conversion lib cannot cover: marker-keyed idempotency, the fail-closed skip of units with no resolvable site (lines 366 and 384), the WHERE NOT EXISTS guard that must not overwrite an operator's live assignment (line 342), the invariant that every migrated assignment is written paused so no active v2 assignment exists at Phase 5 deploy (line 340), and the scoping of both down() deletions.\n\nWHAT BREAKS IF THIS IS SKIPPED. The down() deletion at line 406 selects rows by the note prefix, whereas the statement immediately above it at line 402 selects by ASSIGNMENT_SENTINEL. A rollback therefore removes every feeding_protocols_v2 row whose migrationNote begins with that marker, including rows this migration never inserted, and no test in the repository would catch it. The same absence means a regression in the site-less-unit skip or in the paused-only invariant would reach the database unobserved.\n\nDOWNSTREAM SURFACE. The feeding-protocol v2 source of truth \u2014 protocols plus their per-unit assignments \u2014 which the Phase 5 feeding engine reads and the Phase 6 cutover migration activates.\n\nRECOMMENDED ROOT-CAUSE FIX. Add apps/farm-service/src/database/migrations/__tests__/1806300000000-MigrateFeedingProgramsToProtocolV2.spec.ts following the sibling pattern: assert the paused-only status literal, the WHERE NOT EXISTS assignment guard, the site-less-unit skip, the marker-based idempotency short-circuit, and that down() scopes both deletions to rows this migration wrote.\n\nCONFIDENCE. 0.88 reflects one defensible counter-reading \u2014 that the unit-tested conversion math plus the bootstrap replay already amount to coverage. Neither asserts this migration's effect on data, so the finding stands; the residual uncertainty is interpretive, not factual.",
      "run_id": null,
      "tool_id": "test-gap-adapter",
      "verdict": "true_positive"
    }
  },
  "evidence_refs": [
    "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:22",
    "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:41",
    "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:205",
    "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:335",
    "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:340",
    "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:342",
    "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:366",
    "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:384",
    "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:402",
    "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:406"
  ],
  "request_id": "AIR-aria-evidence-judge-062d5da63359",
  "role": "evidence_judgment",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:402",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:406",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:205",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:41"
      ],
      "id": "premise:1",
      "note": "Holds literally. down() issues two row deletions against live tables: line 402 deletes from \"feeding_protocol_assignments\" keyed on the createdBy sentinel, and line 406 deletes from \"feeding_protocols_v2\" by a LIKE '[migrated:%' note prefix. up() additionally reshapes live data, reading legacy feeding_programs / feeding_protocols rows and writing converted rows into feeding_protocols_v2 (line 205) and feeding_protocol_assignments (line 335). Line 41 records that the file emits no DDL, which is why its hazard is data-shaped rather than schema-shaped.",
      "verdict": "satisfied"
    },
    {
      "evidence_refs": [
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:41",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:22"
      ],
      "id": "premise:2",
      "note": "Holds, with the nuance stated plainly: the migration IS executed against a real Postgres, because farm-service's migration chain is registered in the db-migrate bootstrap-from-scratch integration spec and replayed by runMigrations, which the Database Migration Check workflow runs in CI. That database is a fresh empty volume and its assertions are schema-existence assertions; this file emits no DDL (line 41), so on an empty database every SELECT returns zero rows, no INSERT fires, and the run proves only that the statements parse. The premise is conjunctive \u2014 runs it AND asserts its effect \u2014 and the second conjunct fails everywhere. A repo-wide search for the class name MigrateFeedingProgramsToProtocolV21806300000000 and for the 1806300000000 timestamp returns only this file, the manifest registration that loads it, and documentation; no spec imports it. The unit tests the docblock at line 22 points to cover the pure conversion lib only (describe blocks sampleMatrix, normalizeAssignmentsToRanges, convertProgramToProtocolV2, convertV1ProtocolToV2, helpers) and never construct the migration class or a QueryRunner.",
      "verdict": "satisfied"
    },
    {
      "evidence_refs": [
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:342",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:366",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:402",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:406"
      ],
      "id": "defect",
      "note": "A person must add product code: a spec covering this migration, in the shape the migration's own __tests__ directory already fixes for sixteen sibling migrations including data-backfill ones, which import the migration class, drive up()/down() against a typed mock QueryRunner, and assert the emitted SQL. The uncovered behaviour is precisely the read/write plumbing the pure conversion lib cannot reach: marker-keyed idempotency, the fail-closed skip of site-less units (lines 366 and 384), the WHERE NOT EXISTS guard that must not overwrite a live operator assignment (line 342), the invariant that every migrated assignment is written paused (line 340), and the breadth of the two down() deletions. The rule did not fire on already-correct code: the down() deletion at line 406 selects rows by note prefix rather than by the ASSIGNMENT_SENTINEL used one statement earlier at line 402, so a rollback can remove feeding_protocols_v2 rows this migration never wrote, and no test asserts otherwise.",
      "verdict": "satisfied"
    },
    {
      "evidence_refs": [
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:402",
        "apps/farm-service/src/database/migrations/1806300000000-MigrateFeedingProgramsToProtocolV2.ts:406"
      ],
      "id": "verdict",
      "note": "Both premises and the defect obligation are satisfied against product code at the snapshot, so the verdict is true_positive.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
