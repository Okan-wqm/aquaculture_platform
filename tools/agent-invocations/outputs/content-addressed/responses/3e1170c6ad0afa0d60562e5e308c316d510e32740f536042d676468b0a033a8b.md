{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-37891508302",
  "claim_id": "claim_3b21de2583acec4e",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:3ffe75613eccae71e113d8a6eb7fc7127fdb782c07333c3817ee9e071b5ca4b3",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-primary-planner",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-primary-planner-e798215a0476\",\n  \"claim_id\": \"AIR-aria-primary-planner-e798215a0476\",\n  \"agent_id\": \"aria-primary-planner\",\n  \"role\": \"primary_plan\",\n  \"status\": \"submitted\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"key_changes[0] keeps the obligation's id (OP-F015-20261008-2-key-change-001) and its single path (web/modules/hr-module/src/pages/leaves/LeavesPage.tsx), and now prescribes the mechanism the operator's root-cause remediation needs instead of restating the defect narrative: the Select options at lines 389-395 are derived from the exhaustive LEAVE_STATUS_CONFIG record the page already imports, and the 'as LeaveRequestStatus' assertion at line 398 is deleted behind a checked membership predicate. One factual correction to the obligation's narrative, verified by reading the file in this run: the page binds LeaveRequestStatus and LEAVE_STATUS_CONFIG from the module-local '../../types' barrel (LeavesPage.tsx:33 and :36), not directly from the generated union in web/shared-ui; that local enum carries the same six uppercase GraphQL member names registered at apps/hr-service/src/leave/entities/leave-request.entity.ts:32 from the enum at :18, so routing the page through the existing record closes F-015 completely and adds no second status vocabulary. No file outside the obligation's paths is written by this key change.\",\n      \"evidence_refs\": [\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389\",\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398\",\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:36\",\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:33\",\n        \"apps/hr-service/src/leave/entities/leave-request.entity.ts:18\",\n        \"apps/hr-service/src/leave/entities/leave-request.entity.ts:32\"\n      ]\n    },\n    {\n      \"id\": \"plan_contract:plan_architectural_tier_missing\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"plan_content.architectural_tier is declared as 1 and justified structurally: the option list is the entry set of Record<LeaveRequestStatus, {label, variant}>, so a status cannot be missing without failing type-check at the record's declaration, and option values are that record's keys, so a wrong-cased value is unrepresentable; the deleted assertion at line 398 was the one channel that could smuggle a non-member string into the query variable. All four validation_commands entries name canonical admissible commands in their npx spelling: 'npx nx affected --target=test', 'npx nx affected --target=lint', 'npm run type-check', 'node tools/quality/quality.mjs format check-changed'. The refused entry the gate named (' plan_content.architectural_tier is required, one of 1, 2, 3, 4') is answered by the declared field, not by prose.\",\n      \"evidence_refs\": [\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389\",\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:36\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:33\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:27\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206\",\n    \"apps/hr-service/src/leave/entities/leave-request.entity.ts:18\",\n    \"apps/hr-service/src/leave/entities/leave-request.entity.ts:32\",\n    \"web/shared-ui/src/components/Form/Select.tsx:17\",\n    \"web/shared-ui/src/components/Form/Select.tsx:193\"\n  ],\n  \"plan_content\": {\n    \"schema_version\": 2,\n    \"title\": \"F-015 root cause: derive the leave status filter from the exhaustive LEAVE_STATUS_CONFIG record and delete the assertion that hid the drift\",\n    \"summary\": \"hr-service declares the leave-request status se...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 143835,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 143835,
      "cache_read_input_tokens": 889764,
      "inference_geo": "not_available",
      "input_tokens": 16,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 6649,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 6649,
          "cache_read_input_tokens": 137186,
          "input_tokens": 2,
          "output_tokens": 17399,
          "type": "message"
        }
      ],
      "output_tokens": 41828,
      "output_tokens_details": {
        "thinking_tokens": 27016
      },
      "server_tool_use": {
        "web_fetch_requests": 0,
        "web_search_requests": 0
      },
      "service_tier": "standard",
      "speed": "standard"
    },
    "evidence_notes": [
      "The request's third evidence ref, 'coverage-manifest:plan-cyc-20261008T175911Z-auto-r1.json', was delivered with skipped=\"malformed_ref\" and does not resolve to a repository path, so it is cited nowhere in this envelope. This round's must_satisfy carries no coverage_gap item, so plan_content declares no coverage.waivers block; the impact closure this plan would be measured against is stated in recursive_impact.",
      "The round-1 body carried provenance_refs ['aria-tools/operator-feedback.jsonl:OP-F015-20261008-2']. That path does not exist in this worktree, which matches the recorded guidance that repo-local aria-tools/*.jsonl are per-clone shadows of a ledger that travels on the state branch, so this envelope records the operator-request id OP-F015-20261008-2 in prose and carries no unresolvable provenance ref."
    ],
    "identity_note": "This request envelope rendered request_id, role, convergence id and expected_output_path but carried no claim_id; the required claim_id field is therefore set to the request id, and the executor's own claim id governs on submit. No file tool for writing was available on this route, so the plan is delivered as this envelope's plan_content rather than written to expected_output_path, and no output_path is claimed.",
    "revision": {
      "addresses_review_risk_ids": [
        "CR-001",
        "CR-002",
        "CR-003",
        "CR-004"
      ],
      "divergence_from_challenger": "The challenger's tier-1 device was a NEW label map declared 'satisfies Record<LeaveRequestStatus, string>' inside the page over the generated union in web/shared-ui. Reading the page in this run shows that record already exists and is already imported: LEAVE_STATUS_CONFIG, typed Record<LeaveRequestStatus, {label, variant}> over the module-local six-member enum, bound at LeavesPage.tsx:36 with the type at :33. Declaring a second map would add a second owner of the same vocabulary in the same module, so this plan derives the options from the existing one and keeps a single owner. The challenger's other two mechanics \u2014 delete the assertion at line 398 and type the status channel so the compiler polices it \u2014 are adopted, with the handler expressed as a literal-key setter plus a membership predicate rather than a union-typed parameter, which keeps the assignment compiler-checked without a type assertion.",
      "risk_resolutions": [
        {
          "resolution": "plan_content.architectural_tier is now declared as 1, with the structural justification in architectural_approach: the exhaustive Record<LeaveRequestStatus, \u2026> makes a missing status a type-check failure at the record and makes a wrong-cased option value unrepresentable, and the deleted assertion at line 398 removes the last unchecked channel into filter.status.",
          "risk_id": "CR-001"
        },
        {
          "resolution": "The command set is the full canonical four \u2014 test, lint, 'npm run type-check' and 'node tools/quality/quality.mjs format check-changed' \u2014 and key change 2 adds web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx, which asserts the seven option values, the equality of the non-sentinel values with the record's keys, and that a selected status reaches useLeaveRequests as the enum name. validation_plan states what each command proves.",
          "risk_id": "CR-002"
        },
        {
          "resolution": "key_changes[0].description no longer restates the defect narrative as the instruction: it names the four edits in LeavesPage.tsx (derive the option list from LEAVE_STATUS_CONFIG at module scope, add the 'value is LeaveRequestStatus' membership predicate, add the literal-key status setter, point onChange at it and delete the assertion at line 398), so 'add the two missing statuses as lower-case options' is not a reading the description admits.",
          "risk_id": "CR-003"
        },
        {
          "resolution": "Adopted into this plan's spec step as an exact sequence with the sentinel named: ['', 'DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN'], seven values in total, plus the note that the page passes no placeholder prop so shared-ui's Select renders no additional disabled option.",
          "risk_id": "CR-004"
        }
      ]
    },
    "runtime_attempt_ledger_hash": "sha256:feb48c4372810aec8f7dc2608846f6618cd979f3a6fcb566b2dd11dd0028795b",
    "verified_in_this_run": {
      "note": "Paths read in THIS run to ground the plan's mechanics. The first two are the request's own evidence surfaces and appear in evidence_refs; the remainder are read-verification behind claims in the plan body, listed here rather than in evidence_refs so the admitted evidence set stays exactly the request's refs plus its read-only evidence scope.",
      "paths": [
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:1-120, 180-300, 349-429 \u2014 excerpt content matches the quoted hash region; options literal at 389-395, value at 397, assertion at 398, handleFilterChange at 206, LeaveRequestStatus type import at 33, LEAVE_STATUS_CONFIG import at 36, hooks barrel import at 20-27",
        "apps/hr-service/src/leave/entities/leave-request.entity.ts:1-58 \u2014 enum at 18 with six members at 19-24, registerEnumType at 32; matches the quoted excerpt",
        "web/shared-ui/src/components/Form/Select.tsx:15-24, 104-196 \u2014 SelectOption.value is string | number; native <select> with one <option value=\u2026> per entry; the disabled placeholder option renders only when a placeholder prop is passed",
        "web/modules/hr-module/src/types/leave.types.ts:28-33 and 186-193 \u2014 the module-local LeaveRequestStatus enum (DRAFT='DRAFT' \u2026 WITHDRAWN='WITHDRAWN') and LEAVE_STATUS_CONFIG declared Record<LeaveRequestStatus, {label, variant}> with all six labels in the order DRAFT, PENDING, APPROVED, REJECTED, CANCELLED, WITHDRAWN",
        "web/modules/hr-module/src/pages/scheduling/__tests__/WeeklySchedulePage.spec.tsx:11-188 \u2014 the project's vitest harness: explicit vitest imports, vi.hoisted mock handles, vi.mock('<module>', importOriginal) partial mocks, render inside MemoryRouter",
        "web/modules/hr-module/src/hooks/useEmployees.ts:211 \u2014 useCurrentEmployeeId is declared here, not in useLeaves.ts"
      ]
    }
  },
  "evidence_refs": [
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:36",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:33",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:27",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206",
    "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
    "apps/hr-service/src/leave/entities/leave-request.entity.ts:32",
    "web/shared-ui/src/components/Form/Select.tsx:17",
    "web/shared-ui/src/components/Form/Select.tsx:193"
  ],
  "plan_content": {
    "affected_surfaces": [
      {
        "paths": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx",
          "web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx"
        ]
      }
    ],
    "architectural_approach": "Tier 1 \u2014 make it impossible, using a structural device the repository already owns rather than a second one. The device is the exhaustive Record<LeaveRequestStatus, {label, variant}> that LEAVE_STATUS_CONFIG is declared as. Failure mode one, a missing status: the option list becomes the record's entry set, and the record cannot type-check with a member absent, so when the backend enum gains a status, 'npm run type-check' fails at the record's declaration until a label is added \u2014 and once added, the filter picks it up with no edit to the page at all. Failure mode two, a wrong-cased value: option values are the record's keys, which are the enum's values, i.e. the GraphQL member names by construction, so no hand-typed spelling can enter the list. The remaining channel was the assertion at line 398, which let an unchecked DOM string become a LeaveRequestStatus; deleting it and routing the only status write through a 'value is LeaveRequestStatus' predicate that tests membership in the same record means a non-member string can no longer reach filter.status, and the assignment is checked by the compiler because 'status' is a literal key. Tier 2 is a consequence rather than the claim: the zero-effort default for any future status is now correct. Tiers 3 and 4 are not the highest applicable here, which is why the spec in key change 2 is a regression lock on the wiring and not the mechanism that carries the fix.",
    "architectural_tier": 1,
    "context": "The cause/effect chain, stated for the engineer who will apply this. One authority defines what a leave-request status can be: the enum at apps/hr-service/src/leave/entities/leave-request.entity.ts:18 (DRAFT, PENDING, APPROVED, REJECTED, CANCELLED, WITHDRAWN). registerEnumType at :32 publishes it as a GraphQL enum, and GraphQL puts enum member NAMES on the wire, so the only values a status variable may carry are those six names. The hr-module holds one mirror of that vocabulary and one place that pairs each member with a label: LEAVE_STATUS_CONFIG, typed Record<LeaveRequestStatus, {label, variant}>, which LeavesPage.tsx already imports at line 36 next to the LeaveRequestStatus type at line 33. The filter stopped using it and typed the list by hand (lines 389-395), which produced two defects at once \u2014 two members are absent, so draft and withdrawn requests cannot be filtered, and the four present values are lower-case, so a selected status is not a member of the enum the query expects. The assertion at line 398 is what made both invisible: it tells the compiler 'trust me, this string is a LeaveRequestStatus', and the compiler obeys. If this is skipped, every explicit status selection keeps failing against the contract, draft and withdrawn stay unreachable in the UI, and the next backend status change re-opens the same drift with no build signal. The downstream surface is the hr-module leave list route rendered inside web/shell, and the hr-service resolver that receives $status. The evidence that proves the result: 'npm run type-check' stays green only while the derived list satisfies the exhaustive record, the new spec asserts the seven rendered option values and the value that reaches the query, and lint plus the format gate run clean.",
    "evidence_refs": [
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:36",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:33",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:27",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206",
      "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
      "apps/hr-service/src/leave/entities/leave-request.entity.ts:32",
      "web/shared-ui/src/components/Form/Select.tsx:17",
      "web/shared-ui/src/components/Form/Select.tsx:193"
    ],
    "finding_id": "F-015",
    "key_changes": [
      {
        "description": "Operator request OP-F015-20261008-2 (priority high), root-cause remediation of F-015, inside web/modules/hr-module/src/pages/leaves/LeavesPage.tsx only. Why it matters: hr-service owns the status set once (LeaveRequestStatus, six members, apps/hr-service/src/leave/entities/leave-request.entity.ts:18) and publishes it as a GraphQL enum (registerEnumType at :32), so only the member names are valid input; the hr-module mirror of that vocabulary is LEAVE_STATUS_CONFIG, an exhaustive Record<LeaveRequestStatus, {label, variant}> over all six members, which this page already imports (LeavesPage.tsx:36, with the LeaveRequestStatus type at :33). The page broke the chain by hand-copying the list: the Select options at lines 389-395 carry the '' sentinel plus four members only \u2014 DRAFT and WITHDRAWN requests cannot be filtered at all \u2014 with lower-case values ('pending', 'approved', 'rejected', 'cancelled') that the enum input rejects, and the 'as LeaveRequestStatus' assertion at line 398 stops the compiler from reporting either defect. Make these four edits in this file: (1) at module scope, derive the option list from the existing record \u2014 const LEAVE_STATUS_FILTER_OPTIONS = [{ value: '', label: 'All Statuses' }, ...Object.entries(LEAVE_STATUS_CONFIG).map(([status, config]) => ({ value: status, label: config.label }))] \u2014 and pass it to the Select in place of the literal array at lines 389-395; (2) at module scope, add the membership predicate const isLeaveRequestStatus = (value: string): value is LeaveRequestStatus => Object.prototype.hasOwnProperty.call(LEAVE_STATUS_CONFIG, value); (3) in the component, add const handleStatusFilterChange = (value: string): void => { setFilter((prev) => ({ ...prev, status: isLeaveRequestStatus(value) ? value : undefined })); setPagination({ ...pagination, page: 1 }); }; \u2014 'status' is a literal key there, so TypeScript checks the assigned value against LeaveRequestStatus | undefined with no assertion; (4) point the Select's onChange at line 398 at handleStatusFilterChange(e.target.value) and delete the 'as LeaveRequestStatus' assertion \u2014 nothing replaces it, because the predicate is a checked narrowing rather than an unchecked claim. Keep handleFilterChange (line 206) as the handler for the three string-valued filter keys (leaveTypeId, startDate, endDate) and keep value={filter.status || ''} at line 397 unchanged. Introduce no second status list, label map, or colour map in this file: LEAVE_STATUS_CONFIG remains the single owner of leave-status labels and values. web/shared-ui and the hr-service entity are read, never written.",
        "id": "OP-F015-20261008-2-key-change-001",
        "paths": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
        ]
      },
      {
        "description": "Add web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx, following the harness this project already uses in web/modules/hr-module/src/pages/scheduling/__tests__/WeeklySchedulePage.spec.tsx: vitest + @testing-library/react with explicit vitest imports, vi.hoisted() mock handles, vi.mock('<module>', importOriginal) partial mocks, and render inside MemoryRouter. Mock two hook modules, because the page's hooks are declared in two files and it imports them through the '../../hooks' barrel (LeavesPage.tsx:27): '../../../hooks/useLeaves' (useLeaveRequests, usePendingLeaveApprovals, useLeaveTypes, useApproveLeaveRequest, useRejectLeaveRequest) and '../../../hooks/useEmployees' (useCurrentEmployeeId). Render the page, click the 'Filters' toggle to open the filter panel, and read the status control with getByLabelText('Status') \u2014 shared-ui's Select renders a native <select> with one <option value=\u2026> per entry (web/shared-ui/src/components/Form/Select.tsx:193), and the page passes no placeholder prop, so Select adds no extra disabled option. Assert three things: (a) the rendered option values are exactly ['', 'DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN'] in that order \u2014 the '' All Statuses sentinel first, then the six contract names, seven values in total, and no lower-case value anywhere; (b) the non-sentinel values equal Object.keys(LEAVE_STATUS_CONFIG), which fails if the page ever stops deriving the list from the record; (c) firing a change to 'WITHDRAWN' on that select re-invokes useLeaveRequests with filter.status === 'WITHDRAWN' \u2014 the value GetLeaveRequests sends as the $status enum \u2014 proving DRAFT and WITHDRAWN are filterable and that a selected status reaches the query in contract vocabulary. This spec runs under 'npx nx affected --target=test' on the project's vitest target.",
        "id": "OP-F015-20261008-2-key-change-002",
        "paths": [
          "web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx"
        ]
      }
    ],
    "plan_steps_detailed": [
      "1. In web/modules/hr-module/src/pages/leaves/LeavesPage.tsx, keep the existing bindings \u2014 the LeaveRequestStatus type at line 33 and LEAVE_STATUS_CONFIG at line 36 \u2014 and add no new import for the status vocabulary. (must_satisfy key-change-0; evidence LeavesPage.tsx:33, :36)",
      "2. At module scope in that file, add const LEAVE_STATUS_FILTER_OPTIONS = [{ value: '', label: 'All Statuses' }, ...Object.entries(LEAVE_STATUS_CONFIG).map(([status, config]) => ({ value: status, label: config.label }))]; module scope keeps the array identity stable across renders, matching the file's existing memoization discipline at line 199. (must_satisfy key-change-0; evidence LeavesPage.tsx:36)",
      "3. Replace the hand-written options literal at lines 389-395 with options={LEAVE_STATUS_FILTER_OPTIONS}. The sentinel stays first and the six members follow in LEAVE_STATUS_CONFIG declaration order. (must_satisfy key-change-0; evidence LeavesPage.tsx:389)",
      "4. At module scope, add const isLeaveRequestStatus = (value: string): value is LeaveRequestStatus => Object.prototype.hasOwnProperty.call(LEAVE_STATUS_CONFIG, value); \u2014 a checked narrowing grounded in the same record, so it cannot drift from the option list. (must_satisfy key-change-0; evidence LeavesPage.tsx:33)",
      "5. In the component, add const handleStatusFilterChange = (value: string): void => { setFilter((prev) => ({ ...prev, status: isLeaveRequestStatus(value) ? value : undefined })); setPagination({ ...pagination, page: 1 }); }; \u2014 the literal 'status' key makes TypeScript check the assigned value against LeaveRequestStatus | undefined, and the pagination reset matches handleFilterChange at line 206. (must_satisfy key-change-0; evidence LeavesPage.tsx:206)",
      "6. Change the Select's onChange at line 398 to (e) => handleStatusFilterChange(e.target.value) and delete the 'as LeaveRequestStatus' assertion. Leave value={filter.status || ''} at line 397 and handleFilterChange at line 206 unchanged \u2014 the latter still serves leaveTypeId, startDate and endDate. (must_satisfy key-change-0; evidence LeavesPage.tsx:398)",
      "7. Add web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx per key change 2: mock '../../../hooks/useLeaves' and '../../../hooks/useEmployees' with the vi.hoisted + importOriginal pattern the scheduling page spec uses, render inside MemoryRouter, open the filter panel, then assert the exact seven-value option sequence, equality of the non-sentinel values with Object.keys(LEAVE_STATUS_CONFIG), and that selecting WITHDRAWN re-invokes useLeaveRequests with filter.status === 'WITHDRAWN'. (must_satisfy key-change-0 regression lock; evidence LeavesPage.tsx:27, web/shared-ui/src/components/Form/Select.tsx:193)",
      "8. Run the four declared validation commands and confirm exit 0 on each; report any non-zero exit with its output rather than narrowing the command set."
    ],
    "recursive_impact": "The request carries no impact_graph_refs entries, so no entry is in 'unknown' status and nothing blocks dispatch; the closure below is derived from the two paths this plan writes, with every node traced to its containing validation. (1) Contract end, read-only: LeaveRequestStatus at apps/hr-service/src/leave/entities/leave-request.entity.ts:18, registered as a GraphQL enum at :32 \u2014 known; validated by hr-service's own test target, which this plan does not change because it writes no backend file. (2) Vocabulary mirror consumed by the page: the module-local LeaveRequestStatus type and the exhaustive LEAVE_STATUS_CONFIG record, bound at LeavesPage.tsx:33 and :36 \u2014 known; this plan reads them and writes neither, so the record stays the single owner. (3) Design-system consumer, read-only: shared-ui's Select, whose SelectOption.value accepts string | number (web/shared-ui/src/components/Form/Select.tsx:17) and which renders one native <option value=\u2026> per entry (:193) \u2014 known; the derived string values need no shared-ui change. (4) Defect site, written: the options literal at LeavesPage.tsx:389-395 and the assertion at :398, plus the new sibling spec \u2014 known; both live in project web-hr-module, whose vitest 'test' target and lint target cover them, and which repository-wide 'npm run type-check' also covers. (5) Reverse dependents: both written files sit inside a federated remote and the change alters no export, prop, or type the remote publishes, so no nx reverse dependent changes behaviour; web/shell loads the route at runtime over Module Federation rather than through a build edge. (6) No path under libs/event-contracts/** is written, so the closure contains no NATS event-consumer node; no *.entity.ts is written, so it contains no migration node \u2014 the hr-service entity is read-only evidence here. Most extreme affected node: the leave list route as a user sees it inside web/shell \u2014 draft and withdrawn requests become filterable, and the selected status arrives at the hr-service resolver as a valid enum member instead of a rejected lower-case string.",
    "risks": [
      {
        "affected_files": [
          "web/modules/hr-module/src/types/leave.types.ts",
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
        ],
        "detail": "The page consumes LeaveRequestStatus and LEAVE_STATUS_CONFIG from the module-local types barrel (LeavesPage.tsx:33, :36). Those members carry the same six uppercase names the backend registers (entity:18 registered at :32), which is why deriving the filter from the record yields wire-correct values today and closes F-015 completely. The residual is that the mirror's agreement with the contract is maintained by hand rather than by the compiler. This plan writes only the two declared paths, so changing the mirror is not one of its steps; the admissible route is a separate operator request whose paths name the types module, which keeps the change under its own obligation and cross-review.",
        "evidence_refs": [
          "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
          "apps/hr-service/src/leave/entities/leave-request.entity.ts:32",
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:33"
        ],
        "required_plan_changes": "None inside this plan's paths. The plan step for key change 1 states that LEAVE_STATUS_CONFIG stays the single status vocabulary in the page, so no new mirror is created; a request naming web/modules/hr-module/src/types/leave.types.ts is what can bind the mirror to the generated union.",
        "risk_id": "P-R-001",
        "severity": "MEDIUM",
        "summary": "The hr-module's own LeaveRequestStatus enum is a hand-maintained mirror of the backend GraphQL enum with no compile-time tie to it, so the two could diverge even after this page stops hand-copying the set."
      },
      {
        "affected_files": [
          "web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx"
        ],
        "detail": "LeavesPage.tsx:20-27 imports useLeaveRequests, usePendingLeaveApprovals, useLeaveTypes, useApproveLeaveRequest, useRejectLeaveRequest and useCurrentEmployeeId from '../../hooks', which hides that they are declared in two files. A spec that mocks only the leave module leaves useCurrentEmployeeId live and the render reaches a real query path, which fails for a reason unrelated to the filter under test. The key change names both module paths explicitly so the implementer mocks both with the project's vi.hoisted + importOriginal pattern.",
        "evidence_refs": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:27"
        ],
        "required_plan_changes": "Already applied: key change 2 names '../../../hooks/useLeaves' and '../../../hooks/useEmployees' and cites the existing scheduling page spec as the harness to copy.",
        "risk_id": "P-R-002",
        "severity": "LOW",
        "summary": "The new spec must mock two hook modules, not one: the leave queries and mutations live in useLeaves, while useCurrentEmployeeId lives in useEmployees, and the page imports both through a single barrel."
      },
      {
        "affected_files": [
          "web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx"
        ],
        "detail": "Assertion (a) pins the sequence ['', 'DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN'] because that is the contract vocabulary a reviewer can check by eye, including the sentinel the filter needs to clear a selection. Assertion (b) pins the derivation by comparing the non-sentinel values with Object.keys(LEAVE_STATUS_CONFIG), and it is order-stable under a re-ordering of the record. Both are required: (b) alone would pass a page that re-copied the record's contents into a literal in a different file, and (a) alone would turn a harmless re-ordering into a red suite with no diagnosis.",
        "evidence_refs": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
          "web/shared-ui/src/components/Form/Select.tsx:193"
        ],
        "required_plan_changes": "Already applied: key change 2 requires both assertions, and states that the page passes no placeholder prop, so Select renders exactly seven options and no extra disabled entry.",
        "risk_id": "P-R-003",
        "severity": "LOW",
        "summary": "The exact-sequence assertion is coupled to the declaration order of LEAVE_STATUS_CONFIG, so re-ordering that record would fail the spec without any user-visible defect."
      }
    ],
    "rollback": "Before merge, per written path: 'git checkout HEAD -- web/modules/hr-module/src/pages/leaves/LeavesPage.tsx' restores the page, and 'git rm -f web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx' removes the added spec (plain 'rm -f' on that path if it is not yet staged). After merge: 'git revert <squash-commit-sha>' reverts both files in one commit. No generated type, GraphQL document, database schema, migration, event contract, or backend file is written by this plan \u2014 web/shared-ui and apps/hr-service are read only \u2014 so there is no contract or data state to unwind and the revert is complete on its own.",
    "schema_version": 2,
    "summary": "hr-service declares the leave-request status set exactly once (LeaveRequestStatus, six members, apps/hr-service/src/leave/entities/leave-request.entity.ts:18) and publishes it as a GraphQL enum (registerEnumType at :32), so the wire vocabulary is the enum member names; the hr-module already mirrors that vocabulary in LEAVE_STATUS_CONFIG, an exhaustive Record<LeaveRequestStatus, {label, variant}> that LeavesPage.tsx imports at line 36. The page's filter ignores that owner and hand-copies the set: the Select options at lines 389-395 offer the '' sentinel plus four members (DRAFT and WITHDRAWN are unfilterable) with lower-case values the enum input rejects, and the 'as LeaveRequestStatus' assertion at line 398 keeps the compiler quiet about both defects. This plan derives the options from the existing record inside LeavesPage.tsx, replaces the assertion with a runtime membership predicate so the only path from the DOM into filter.status is checked, and adds one vitest spec that pins the seven rendered option values and the value the query receives. Because the record must satisfy Record<LeaveRequestStatus, \u2026>, a future backend status change breaks 'npm run type-check' at the record until a label exists and then reaches the filter with no further edit \u2014 the wrong behaviour becomes unrepresentable rather than discouraged.",
    "title": "F-015 root cause: derive the leave status filter from the exhaustive LEAVE_STATUS_CONFIG record and delete the assertion that hid the drift",
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
    "validation_plan": "Each declared command carries a specific burden of proof. 'npm run type-check' is the tier-1 witness for must_satisfy key-change-0: it compiles LeavesPage.tsx against the exhaustive Record<LeaveRequestStatus, \u2026>, so a derived option list that lost a member, or a status assignment that is not a checked member, cannot pass \u2014 this is the gate the round-1 command set omitted, and it is the only one that sees the type-level property the remediation rests on. 'npx nx affected --target=test' runs project web-hr-module's vitest target, including the new spec, and is the behavioural witness: the exact sequence ['', 'DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN'] proves the two absent statuses are now offered and that no lower-case value survives, the Object.keys(LEAVE_STATUS_CONFIG) equality proves the list is still derived from the record rather than re-copied, and the change-to-WITHDRAWN assertion proves the selected value reaches useLeaveRequests as the enum name the $status variable requires. 'npx nx affected --target=lint' proves the edited page and the new spec carry no unused binding after the assertion and literal array are removed, and no rule violation in the added predicate. 'node tools/quality/quality.mjs format check-changed' proves both written files match the repository's enforced formatting. Together they answer must_satisfy key-change-0 (behaviour plus type-level containment, inside the one declared path) and plan_contract:plan_architectural_tier_missing (the declared tier 1 is witnessed by type-check rather than asserted in prose)."
  },
  "request_id": "AIR-aria-primary-planner-e798215a0476",
  "role": "primary_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:36",
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:33",
        "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
        "apps/hr-service/src/leave/entities/leave-request.entity.ts:32"
      ],
      "id": "key-change-0",
      "note": "key_changes[0] keeps the obligation's id (OP-F015-20261008-2-key-change-001) and its single path (web/modules/hr-module/src/pages/leaves/LeavesPage.tsx), and now prescribes the mechanism the operator's root-cause remediation needs instead of restating the defect narrative: the Select options at lines 389-395 are derived from the exhaustive LEAVE_STATUS_CONFIG record the page already imports, and the 'as LeaveRequestStatus' assertion at line 398 is deleted behind a checked membership predicate. One factual correction to the obligation's narrative, verified by reading the file in this run: the page binds LeaveRequestStatus and LEAVE_STATUS_CONFIG from the module-local '../../types' barrel (LeavesPage.tsx:33 and :36), not directly from the generated union in web/shared-ui; that local enum carries the same six uppercase GraphQL member names registered at apps/hr-service/src/leave/entities/leave-request.entity.ts:32 from the enum at :18, so routing the page through the existing record closes F-015 completely and adds no second status vocabulary. No file outside the obligation's paths is written by this key change.",
      "verdict": "satisfied"
    },
    {
      "evidence_refs": [
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398"
      ],
      "id": "plan_contract:plan_architectural_tier_missing",
      "note": "plan_content.architectural_tier is declared as 1 and justified structurally: the option list is the entry set of Record<LeaveRequestStatus, {label, variant}>, so a status cannot be missing without failing type-check at the record's declaration, and option values are that record's keys, so a wrong-cased value is unrepresentable; the deleted assertion at line 398 was the one channel that could smuggle a non-member string into the query variable. All four validation_commands entries name canonical admissible commands in their npx spelling: 'npx nx affected --target=test', 'npx nx affected --target=lint', 'npm run type-check', 'node tools/quality/quality.mjs format check-changed'. The refused entry the gate named (' plan_content.architectural_tier is required, one of 1, 2, 3, 4') is answered by the declared field, not by prose.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
