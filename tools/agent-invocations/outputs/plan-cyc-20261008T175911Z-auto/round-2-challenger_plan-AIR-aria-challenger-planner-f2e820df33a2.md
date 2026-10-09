{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-37891508302",
  "claim_id": "claim_a5876c2602fe811c",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:151414eb44dd797050a8bd5446c460165e7a7d2980e4c18de2505b73a6d9ff7a",
    "agent_dispatch_model": "glm-5.3",
    "agent_subagent_type": "aria-challenger-planner",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-challenger-planner-f2e820df33a2\",\n  \"claim_id\": \"AIR-aria-challenger-planner-f2e820df33a2\",\n  \"agent_id\": \"aria-challenger-planner\",\n  \"role\": \"challenger_plan\",\n  \"status\": \"submitted\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"My key_changes[0] (id OP-F015-20261008-2-key-change-001) applies exactly the obligated remediation: the hand-written four-entry lower-case option list at LeavesPage.tsx:389 is replaced by an exhaustive Record<LeaveRequestStatus, string> whose keys are the six wire enum names, and the blind `as LeaveRequestStatus` assertion in the onChange at :398 is replaced by a membership guard, so only valid enum names flow through handleFilterChange (:206) into useLeaveRequests' filter argument (:36) and GetLeaveRequests' $status. It touches only web/modules/hr-module/src/pages/leaves/LeavesPage.tsx \u2014 the sole path the obligation lists. The backend enum (leave-request.entity.ts:18) and registerEnumType (:32) are the untouched contract source; the shared Select passes values through verbatim (Select.tsx:17), so no other file is needed for the fix itself.\",\n      \"evidence_refs\": [\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389\",\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398\",\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:27\",\n        \"apps/hr-service/src/leave/entities/leave-request.entity.ts:18\",\n        \"apps/hr-service/src/leave/entities/leave-request.entity.ts:32\",\n        \"web/shared-ui/src/components/Form/Select.tsx:17\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:27\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:36\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:33\",\n    \"apps/hr-service/src/leave/entities/leave-request.entity.ts:18\",\n    \"apps/hr-service/src/leave/entities/leave-request.entity.ts:32\",\n    \"web/shared-ui/src/components/Form/Select.tsx:17\",\n    \"web/shared-ui/src/components/Form/Select.tsx:193\"\n  ],\n  \"plan_content\": {\n    \"schema_version\": 2,\n    \"title\": \"F-015 root cause: derive the leave status filter from the LeaveRequestStatus contract, not a hand copy\",\n    \"summary\": \"F-015's root cause is a third hand-copy of the leave status set: hr-service declares it once in the LeaveRequestStatus enum (leave-request.entity.ts:18) and again on the wire via registerEnumType (:32) as upper-case names, while the leave list's filter offers a stale four-entry lower-case copy asserted past the compiler. The copy both hides DRAFT and WITHDRAWN and sends values the GraphQL enum cannot coerce, so no non-empty status selection reaches GetLeaveRequests' $status correctly. This plan fixes the page only: Select options derive from an exhaustive Record keyed by the LeaveRequestStatus union the page already imports (:27), and a membership guard replaces the `as LeaveRequestStatus` cast (:398), making an incomplete or invalid status list a compile error (tier 1). A regression spec in web-hr-module pins the six wire-format option values.\",\n    \"affected_surfaces\": [\n      { \"paths\": [\"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx\"] },\n      { \"paths\": [\"web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx\"] }\n    ],\n    \"key_changes\": [\n      {\n        \"id\": \"OP-F015-20261008-2-key-change-001\",\n        \"description\": \"In LeavesPage.tsx only: delete the hand-written status option list at :389 (four entries, lower-case values) and replace it with an exhaustive label map `const LEAVE_STATUS_FILTER_LABELS: Record<LeaveRequestStatus, string>` whose keys are exactly the six wire enum names DRAFT, PENDING, APPROVED, REJECTED, CANCELLE...",
    "evidence_note": "The coverage-manifest entry in the evidence payload arrived malformed (skipped='malformed_ref') and is not cited anywhere in this envelope; prior round history shows coverage-manifest paths rejected as unverifiable (agent_evidence_path_missing / agent_evidence_not_repo_verified), so this plan cites only resolvable file:line refs. Excerpt hashes for LeavesPage.tsx, leave-request.entity.ts, and Select.tsx were internally consistent with the cited claims; no re-read was needed.",
    "independence_traversal": "Read consumer-to-contract backward, meeting the changed page last: (1) wire contract \u2014 the LeaveRequestStatus enum (leave-request.entity.ts:18) and registerEnumType (:32) declare six values with upper-case names on the wire; (2) the generated web union and GetLeaveRequests' $status typing per the obligation's contract statement; (3) the page's consumption \u2014 the option list at LeavesPage.tsx:389, the cast at :398, handleFilterChange's value||undefined store at :206, the filter argument to useLeaveRequests at :36; (4) the shared Select passthrough (Select.tsx:17 value: string | number; option rendering at :193), confirming no shared-ui edit is required.",
    "runtime_attempt_ledger_hash": "sha256:a0b3ae90897a6a9f4cae3b486d9d66869f05c63e9ba945d3a0fd127705cab56c"
  },
  "evidence_refs": [
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:27",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:36",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:33",
    "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
    "apps/hr-service/src/leave/entities/leave-request.entity.ts:32",
    "web/shared-ui/src/components/Form/Select.tsx:17",
    "web/shared-ui/src/components/Form/Select.tsx:193"
  ],
  "plan_content": {
    "affected_surfaces": [
      {
        "paths": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
        ]
      },
      {
        "paths": [
          "web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx"
        ]
      }
    ],
    "architectural_approach": "Tier 1 \u2014 make the stale-copy failure mode unrepresentable in the type system, within the one file the obligation allows. The Record<LeaveRequestStatus, string> label map is the enforcement point: its keys must be exactly the union members, so omitting WITHDRAWN, misspelling CANCELLED, or re-introducing a lower-case 'pending' is a compile error instead of a silent copy. Option values come from those same keys (wire enum names), and the onChange membership guard removes the assertion that previously bypassed the compiler, so invalid strings become 'no filter' rather than a type lie. Labels stay hand-written \u2014 they are genuinely page-local presentation. LEAVE_STATUS_CONFIG (imported at :33) was considered as the label source and deliberately not made load-bearing: its key casing is not in the admissible evidence, while the Record's correctness is compiler-proven.",
    "architectural_tier": 1,
    "context": "Junior-engineer frame. One fact \u2014 which statuses a leave request can have \u2014 is already declared twice by the platform: the enum at apps/hr-service/src/leave/entities/leave-request.entity.ts:18 (draft, pending, approved, rejected, cancelled, withdrawn) and the GraphQL enum registerEnumType publishes at :32, whose wire values are the upper-case names. The leave list then hand-copies that set a third time (LeavesPage.tsx:389) and the copy went stale in two directions at once: it dropped DRAFT and WITHDRAWN, and it wrote lower-case strings ('pending') where the wire carries 'PENDING'. The `as LeaveRequestStatus` cast at :398 is what let it compile \u2014 an assertion tells the compiler to stop checking, the same suppression class (.skip / @ts-ignore / as-any) the repo's code-writing standards flag. Cause/effect chain if skipped: every non-empty status selection sends a value the $status enum cannot coerce, so the filter errors or matches nothing for all four offered statuses, the two missing statuses stay unreachable as choices, and the next backend status addition re-stales the copy again (F-003/F-005/F-007/F-008 already cite older lines of this same list). Downstream surface: filter.status flows through handleFilterChange (:206, which stores value || undefined and resets to page 1) into useLeaveRequests' filter argument (:36) and out as GetLeaveRequests' $status; the shared Select passes option values through untouched (Select.tsx:17), so the fix belongs in the page, not in shared-ui (whose tree is read-only evidence scope here). Proof the result holds: the Record-keyed options make an incomplete or invalid list a type error under `npm run type-check`, and the new spec fails `npx nx affected --target=test` if anyone re-introduces a hand copy.",
    "evidence_refs": [
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:27",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:36",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:33",
      "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
      "apps/hr-service/src/leave/entities/leave-request.entity.ts:32",
      "web/shared-ui/src/components/Form/Select.tsx:17",
      "web/shared-ui/src/components/Form/Select.tsx:193"
    ],
    "finding_id": "F-015",
    "key_changes": [
      {
        "description": "In LeavesPage.tsx only: delete the hand-written status option list at :389 (four entries, lower-case values) and replace it with an exhaustive label map `const LEAVE_STATUS_FILTER_LABELS: Record<LeaveRequestStatus, string>` whose keys are exactly the six wire enum names DRAFT, PENDING, APPROVED, REJECTED, CANCELLED, WITHDRAWN; render the Select options from those keys, keeping the leading { value: '', label: 'All Statuses' } entry, the fullWidth/id bindings, and value={filter.status || ''} so the controlled value always matches a rendered option (Select renders option values verbatim, Select.tsx:17/:193). Replace the `e.target.value as LeaveRequestStatus` assertion in the filter onChange (:398) with a membership guard over the same Record, so only valid enum names enter filter.status and flow through handleFilterChange (:206) into useLeaveRequests' filter argument (:36) and GetLeaveRequests' $status; any other string resolves to undefined (filter cleared). If `npm run type-check` shows the LeaveRequestStatus imported from '../../types' (:27) is not the generated upper-case union, re-point the import line inside LeavesPage.tsx to the generated union surface used by web/modules/hr-module/src/graphql/leave.operations.ts \u2014 that import line is the only additional edit this key change may make.",
        "id": "OP-F015-20261008-2-key-change-001",
        "paths": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
        ]
      },
      {
        "description": "Extend the existing LeavesPage spec (creating the case block if absent) to pin the contract the Record enforces: the status filter renders 'All Statuses' plus exactly six status options; every option value is a member of the generated LeaveRequestStatus union (upper-case wire names); the empty-string selection maps to undefined so the unfiltered query stays unfiltered. A future re-introduced hand copy fails `npx nx affected --target=test` at this spec.",
        "id": "OP-F015-20261008-2-key-change-002",
        "paths": [
          "web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx"
        ]
      }
    ],
    "plan_steps_detailed": [
      "1. In LeavesPage.tsx define the exhaustive label map keyed by the imported LeaveRequestStatus union: DRAFT/PENDING/APPROVED/REJECTED/CANCELLED/WITHDRAWN.",
      "2. Build the status Select options from the map entries, prefixed with { value: '', label: 'All Statuses' }; keep fullWidth, id, and value={filter.status || ''} unchanged so the controlled value always matches a rendered option (Select renders values verbatim, Select.tsx:17/:193).",
      "3. Add the membership guard and use it in the onChange in place of `as LeaveRequestStatus` (:398); invalid strings map to undefined, which handleFilterChange (:206) already stores as filter-cleared and resets pagination.",
      "4. Contingency, same file only: if type-check shows the ../../types LeaveRequestStatus (:27) is not the generated upper-case union, change the import line in LeavesPage.tsx to the generated union surface leave.operations.ts uses.",
      "5. Extend the LeavesPage spec: six status options plus All; every option value in the generated union; '' maps to undefined.",
      "6. Run the four canonical commands; the Record plus type-check is the structural proof (tier 1), the spec is the regression pin."
    ],
    "recursive_impact": "Touched project is web-hr-module only; both surfaces are inside it. In-page flow: status Select \u2192 membership guard \u2192 handleFilterChange (:206) \u2192 filter state \u2192 useLeaveRequests (on the 'mine' tab as { ...filter, employeeId }, :36) \u2192 GetLeaveRequests' $status. The 'pending' tab reads usePendingLeaveApprovals and ignores filter.status, so it is unaffected. The contract end is unchanged: the hr-service enum, registerEnumType, the generated graphql-types union, and the leave.operations query text are all untouched (entity and shared-ui trees are read-only evidence scope); the fix changes only which strings the page offers and stores. No libs/event-contracts path is written, so the closure adds no event-consumer nodes; no *.entity.ts is written, so no migration node couples in. No shared-ui file changes, so web-shared-ui's dependent projects are untouched by construction. Any reverse-dependent node the machine adds beyond project web-hr-module is answered in the next revision by widening affected_surfaces or an auditable coverage.waivers entry, never by prose.",
    "risks": [
      {
        "evidence_refs": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:27"
        ],
        "mitigation": "`npm run type-check` plus the spec's union-membership assertion expose it; plan step 4 re-points the page's import to the generated union within the same file.",
        "severity": "MEDIUM",
        "summary": "The LeaveRequestStatus imported from ../../types (LeavesPage.tsx:27) is not directly evidenced as the generated upper-case union; if it is a lower-case local copy, the Record would encode lower-case wire values and repeat the defect."
      },
      {
        "evidence_refs": [
          "apps/hr-service/src/leave/entities/leave-request.entity.ts:18"
        ],
        "mitigation": "This is the capability restoration F-015 asks for \u2014 the six-value enum at leave-request.entity.ts:18 is the contract \u2014 flagged here for reviewer awareness, not change.",
        "severity": "LOW",
        "summary": "DRAFT and WITHDRAWN become selectable filter choices for the first time; filtering by them surfaces requests that were invisible under the four-status copy."
      },
      {
        "evidence_refs": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206",
          "web/shared-ui/src/components/Form/Select.tsx:193"
        ],
        "mitigation": "Filter state is per-mount component state, not persisted, so no stale lower-case value survives navigation; the '' fallback binding and the All Statuses option are preserved (:206; Select.tsx:193).",
        "severity": "LOW",
        "summary": "Controlled-select mismatch: if option values change case while a stored filter value persisted in the old case, the select would render no matching option."
      }
    ],
    "rollback": "Revert the single commit touching the two files. No generated code, migration, schema, or query-text change is involved \u2014 GetLeaveRequests' $status keeps its enum type and the backend contract is untouched \u2014 so rollback carries no contract or data consequence beyond re-opening F-015's defect in the page.",
    "schema_version": 2,
    "summary": "F-015's root cause is a third hand-copy of the leave status set: hr-service declares it once in the LeaveRequestStatus enum (leave-request.entity.ts:18) and again on the wire via registerEnumType (:32) as upper-case names, while the leave list's filter offers a stale four-entry lower-case copy asserted past the compiler. The copy both hides DRAFT and WITHDRAWN and sends values the GraphQL enum cannot coerce, so no non-empty status selection reaches GetLeaveRequests' $status correctly. This plan fixes the page only: Select options derive from an exhaustive Record keyed by the LeaveRequestStatus union the page already imports (:27), and a membership guard replaces the `as LeaveRequestStatus` cast (:398), making an incomplete or invalid status list a compile error (tier 1). A regression spec in web-hr-module pins the six wire-format option values.",
    "title": "F-015 root cause: derive the leave status filter from the LeaveRequestStatus contract, not a hand copy",
    "validation_commands": [
      {
        "cmd": "npx nx affected --target=test",
        "expected_exit": 0,
        "timeout_ms": 1800000
      },
      {
        "cmd": "npm run type-check",
        "expected_exit": 0,
        "timeout_ms": 900000
      },
      {
        "cmd": "npx nx affected --target=lint",
        "expected_exit": 0,
        "timeout_ms": 900000
      },
      {
        "cmd": "node tools/quality/quality.mjs format check-changed",
        "expected_exit": 0,
        "timeout_ms": 300000
      }
    ],
    "validation_plan": "`npm run type-check` proves exhaustiveness and wire-name validity of the option set \u2014 the tier-1 claim's structural evidence. `npx nx affected --target=test` runs web-hr-module's vitest suite including the new LeavesPage spec assertions. `npx nx affected --target=lint` and `node tools/quality/quality.mjs format check-changed` keep the standard gates green for the edited page and spec."
  },
  "request_id": "AIR-aria-challenger-planner-f2e820df33a2",
  "role": "challenger_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:27",
        "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
        "apps/hr-service/src/leave/entities/leave-request.entity.ts:32",
        "web/shared-ui/src/components/Form/Select.tsx:17"
      ],
      "id": "key-change-0",
      "note": "My key_changes[0] (id OP-F015-20261008-2-key-change-001) applies exactly the obligated remediation: the hand-written four-entry lower-case option list at LeavesPage.tsx:389 is replaced by an exhaustive Record<LeaveRequestStatus, string> whose keys are the six wire enum names, and the blind `as LeaveRequestStatus` assertion in the onChange at :398 is replaced by a membership guard, so only valid enum names flow through handleFilterChange (:206) into useLeaveRequests' filter argument (:36) and GetLeaveRequests' $status. It touches only web/modules/hr-module/src/pages/leaves/LeavesPage.tsx \u2014 the sole path the obligation lists. The backend enum (leave-request.entity.ts:18) and registerEnumType (:32) are the untouched contract source; the shared Select passes values through verbatim (Select.tsx:17), so no other file is needed for the fix itself.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
