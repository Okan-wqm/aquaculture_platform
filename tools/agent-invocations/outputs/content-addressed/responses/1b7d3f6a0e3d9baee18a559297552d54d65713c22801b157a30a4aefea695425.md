{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-37735581293",
  "claim_id": "claim_bd50c97e7e8d6899",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:3ffe75613eccae71e113d8a6eb7fc7127fdb782c07333c3817ee9e071b5ca4b3",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-primary-planner",
    "agent_text": "Evidence is complete and consistent. The causal chain is now exact: the server enum's **persisted values** are lower-case (`'draft'`\u2026), but `registerEnumType` puts the enum **keys** on the wire \u2014 which is why the generated union is UPPER-case. The page's hand copy copied the DB values instead of the wire names.\n\n```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-primary-planner-0c41a75a5f21\",\n  \"claim_id\": \"AIR-aria-primary-planner-0c41a75a5f21\",\n  \"agent_id\": \"aria-primary-planner\",\n  \"role\": \"primary_plan\",\n  \"status\": \"submitted\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"key_changes[0] stays bounded to the single file the obligation lists (web/modules/hr-module/src/pages/leaves/LeavesPage.tsx) and performs exactly the remediation the plan_description names: the leave list status filter stops being a hand-written copy and is derived from the declared contract, so all six statuses including DRAFT and WITHDRAWN become filterable and the emitted value matches the wire enum GET_LEAVE_REQUESTS types $status against. The obligation's description was the operator's prose; this revision restates the same subject as executable steps on the same path. Reading the file in this run established that the vocabulary is additionally re-declared at web/modules/hr-module/src/types/leave.types.ts:28, so the single-source correction lands in key_changes[1] on that separate path, leaving key_changes[0]'s file set unchanged.\",\n      \"evidence_refs\": [\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389\",\n        \"web/modules/hr-module/src/types/leave.types.ts:28\"\n      ]\n    },\n    {\n      \"id\": \"plan_contract:plan_architectural_tier_missing\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"plan_content.architectural_tier is now claimed as 1. The mechanism is structural, not advisory: the module's status type becomes an alias of the generated union, the option tuple is constrained by `satisfies readonly LeaveRequestStatus[]`, an Exclude<...> extends never assertion fails the build if the contract gains a member the tuple lacks, Record<LeaveRequestStatus, ...> forces an exhaustive label map, and a key-correlated handleFilterChange signature makes an arbitrary string unassignable to filter.status. All four validation_commands are canonical-suite spellings; npm run type-check is the command that executes the tier-1 assertions.\",\n      \"evidence_refs\": [\n        \"web/shared-ui/src/generated/graphql-types.ts:8743\",\n        \"web/modules/hr-module/src/types/leave.types.ts:186\"\n      ]\n    }\n  ],\n  \"evidence_refs\": [\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:149\",\n    \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:138\",\n    \"web/modules/hr-module/src/types/leave.types.ts:28\",\n    \"web/modules/hr-module/src/types/leave.types.ts:170\",\n    \"web/modules/hr-module/src/types/leave.types.ts:186\",\n    \"web/modules/hr-module/src/types/index.ts:10\",\n    \"web/modules/hr-module/src/graphql/leave.operations.ts:58\",\n    \"web/modules/hr-module/src/pages/scheduling/__tests__/WeeklySchedulePage.spec.tsx:11\",\n    \"apps/hr-service/src/leave/entities/leave-request.entity.ts:18\",\n    \"apps/hr-service/src/leave/entities/leave-request.entity.ts:32\",\n    \"web/shared-ui/src/generated/graphql-types.ts:8743\"\n  ],\n  \"plan_content\": {\n    \"schema_version\": 2,\n    \"architectural_tier\": 1,\n    \"finding_id\": \"F-015\",\n    \"title\": \"F-015 root fix: derive the hr-module leave status vocabulary from the generated LeaveRequestStatus contract, removing the module's duplicate enum and the page's hand-copied filter options\",\n    \"summary\": \"The leave-request status vocabulary is declared three times. hr-service declares it once (leave-request.entity.ts:18) and registers it as a ...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 155040,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 155040,
      "cache_read_input_tokens": 913597,
      "inference_geo": "not_available",
      "input_tokens": 16,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 13355,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 13355,
          "cache_read_input_tokens": 141685,
          "input_tokens": 2,
          "output_tokens": 15110,
          "type": "message"
        }
      ],
      "output_tokens": 41262,
      "output_tokens_details": {
        "thinking_tokens": 23745
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
        "CR-005"
      ],
      "cross_review_correction_adopted": "CR-004 was filed primary_to_challenger and is not this plan's risk to resolve, so it is not claimed above. Its substance was applied to this plan's own waiver wording: both waivers state what is verifiably true \u2014 the status identifiers and their runtime string values are unchanged and the new exports are additive \u2014 and each names platform-wide npm run type-check as the gate that actually compiles reverse dependents, rather than claiming the module's exported surface is untouched while the plan adds exports to it.",
      "evidence_corrections": [
        "Round 1 and the round-1 challenger both located F-015 solely in the page's Select options. Reading the module in this run established a second, independent declaration of the vocabulary at web/modules/hr-module/src/types/leave.types.ts:28; the page imports LeaveRequestStatus from '../../types', not from the generated types. A page-only fix leaves that duplicate in place, so it would not be a root-cause fix. This revision removes it.",
        "The round-1 challenger's RISK-1 premise is not borne out: LEAVE_STATUS_CONFIG (leave.types.ts:186-192) is already exhaustive over all six statuses with UPPER-case keys, so DRAFT and WITHDRAWN rows render their badges correctly today. The defect is confined to the filter path. Stating this keeps the plan from claiming a fix for a defect that does not exist.",
        "The `as LeaveRequestStatus` cast at LeavesPage.tsx:398 is inert, not merely relocatable: handleFilterChange's value parameter is `string | undefined` (line 206), so the cast never constrained the call boundary. Removing the cast alone would change nothing structurally, which is why this plan narrows the function signature as well. The round-1 challenger's plan treated the cast as the hole.",
        "A second cast exists at LeavesPage.tsx:149, `row.status === ('PENDING' as LeaveRequestStatus)`. Neither round-1 plan named it. It is removed in key change 1.",
        "The lower-case option values match the server enum's persisted values (leave-request.entity.ts:19-24), not the GraphQL wire names: registerEnumType (line 32) publishes the enum keys, which is why the generated union at graphql-types.ts:8743-8749 is UPPER-case. The filter therefore fails for all four statuses it currently offers, not only for the two it omits.",
        "The challenger proposed importing the generated union from web/shared-ui/src/generated/graphql-types.ts, but web/shared-ui/src/index.ts does not export the generated types and the package exports map has no subpath for them. The working mechanism is the tsconfig path alias @platform/shared-ui/* and the import specifier '@platform/shared-ui/generated/graphql-types', already used by sibling modules. Those two verification sources lie outside this request's admissible evidence scope, so they are reported as narrative and are not cited in evidence_refs; the import specifier is named concretely in key change 2 so the implementer does not have to rediscover it."
      ],
      "evidence_scope_note": "The evidence_payload entry `coverage-manifest:plan-cyc-20261008T043925Z-auto-r1.json` was delivered with skipped=\"malformed_ref\" and does not resolve to a repository file, so it is not cited anywhere in this envelope. Every ref cited lies in the request's evidence_refs, the read-only evidence scope, or allowed_scope, and each was read in this run.",
      "excerpt_sufficiency": "The LeavesPage.tsx excerpt (lines 349-429, content_hash sha256:f123f188...) matched the file exactly, and the leave-request.entity.ts excerpt (lines 1-58, sha256:ab62d22f...) likewise. Both files were read beyond their excerpts because the excerpts were insufficient for the claims this plan makes: the page excerpt does not show the import block, handleFilterChange, or the second cast at line 149, and nothing in either excerpt reveals the module's duplicate declaration. The entity excerpt alone also could not establish the wire spelling, which required the generated union.",
      "resolution_notes": [
        "CR-001 (blocking, architectural_tier missing): plan_content.architectural_tier is now 1, with the mechanism named per component \u2014 satisfies-constrained tuple, Exclude<...> extends never exhaustiveness, Record-forced label map, key-correlated handleFilterChange signature, and a guard at the DOM boundary. The validation set now leads with npm run type-check, which is the command that actually executes those assertions; round 1 declared neither type-check nor the format gate.",
        "CR-002 (material, no regression lock): key change 3 adds web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx, and the spec file is listed in affected_surfaces. It asserts the rendered option values equal the six contract members plus the empty All-Statuses entry, that no option carries a lower-case value, and that the guard rejects 'pending' and 'unknown' \u2014 the two strings that encode this regression.",
        "CR-003 (material, no coverage block): plan_content.coverage.waivers now carries dependents-of:web-hr-module and project:web-shell. affected_surfaces was also widened to the types file that holds the duplicate declaration, which moves the real fix inside the plan's reached paths rather than leaving it to a waiver.",
        "CR-005 (nice_to_have, shape drift): affected_surfaces is authored directly as [{paths:[...]}], so it no longer relies on the ci_executor V8.4 normalizer to wrap a flat string list."
      ]
    },
    "runtime_attempt_ledger_hash": "sha256:57a11a54c61b1849c06ffface10d2f38f23b15f07eb675b1b7648bc5c4fce381"
  },
  "evidence_refs": [
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:149",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:138",
    "web/modules/hr-module/src/types/leave.types.ts:28",
    "web/modules/hr-module/src/types/leave.types.ts:170",
    "web/modules/hr-module/src/types/leave.types.ts:186",
    "web/modules/hr-module/src/types/index.ts:10",
    "web/modules/hr-module/src/graphql/leave.operations.ts:58",
    "web/modules/hr-module/src/pages/scheduling/__tests__/WeeklySchedulePage.spec.tsx:11",
    "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
    "apps/hr-service/src/leave/entities/leave-request.entity.ts:32",
    "web/shared-ui/src/generated/graphql-types.ts:8743"
  ],
  "plan_content": {
    "affected_surfaces": [
      {
        "paths": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx",
          "web/modules/hr-module/src/types/leave.types.ts",
          "web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx"
        ]
      }
    ],
    "architectural_approach": "Tier 1 \u2014 make it impossible. The wrong behaviour here is a status vocabulary that can disagree with the contract, so the fix removes the second and third copies and makes both divergence directions unrepresentable. Adding an off-contract member to LEAVE_REQUEST_STATUSES fails `satisfies readonly LeaveRequestStatus[]`. The contract gaining a member fails the `Exclude<LeaveRequestStatus, (typeof LEAVE_REQUEST_STATUSES)[number]> extends never` assertion until the tuple is extended. A label going missing fails `Record<LeaveRequestStatus, ...>`. An arbitrary string reaching filter.status fails the key-correlated handleFilterChange signature, which replaces a `string | undefined` parameter that accepted anything. At the one genuinely untrusted boundary \u2014 a DOM select yields a plain string \u2014 an exported type guard narrows before the value enters state, so both existing `as LeaveRequestStatus` casts are deleted rather than moved, satisfying the CLAUDE.md prohibition on suppressions instead of working around it. The derivation is anchored on the repository's own proven mechanism for consuming generated contract types: the tsconfig path alias @platform/shared-ui/* maps to web/shared-ui/src/* and sibling modules already import the generated types through it (verified in this run by reading tsconfig.base.json and web/modules/sensor-module/src/types/registration.types.ts \u2014 both outside this request's admissible evidence scope, so they are reported here as verification narrative and are not cited as evidence_refs). This also means the fix needs no write to web/shared-ui, which is read-only in this request. Key change 3 adds tier-3 detection on top of the tier-1 mechanism; the tier claim is 1 because the enforcement is structural rather than only detective. Note that hr-service's nested steering file names a repository-level tests/invariants/hr-graphql-fe-be-parity.spec.ts; that file was not read in this run and no claim is made about its coverage, and it lies outside allowed_scope, so this plan places the structural fix at the module's own declaration where the duplicate lives.",
    "architectural_tier": 1,
    "context": "What must be done: the leave list's status filter must offer exactly the status set the API declares, spelled the way the API puts it on the wire, and the module must stop keeping its own copy of that set. Why it matters: hr-service declares the vocabulary once at apps/hr-service/src/leave/entities/leave-request.entity.ts:18 with lower-case persisted values, then registers it as a GraphQL enum at line 32; registerEnumType publishes the enum KEYS, so the wire values are UPPER-case and the generated client union at web/shared-ui/src/generated/graphql-types.ts:8743 is exactly 'APPROVED' | 'CANCELLED' | 'DRAFT' | 'PENDING' | 'REJECTED' | 'WITHDRAWN'. What breaks today: LeavesPage.tsx:389-395 offers four options whose values are the server's persisted lower-case strings, so (a) DRAFT and WITHDRAWN cannot be filtered at all and (b) the four that exist send $status a value the schema enum does not contain, and GET_LEAVE_REQUESTS declares $status: LeaveRequestStatus (leave.operations.ts:58) \u2014 so the status filter does not work for any choice a user can make. Why it was invisible: the `as LeaveRequestStatus` cast at line 398 reads like a type check but handleFilterChange's value parameter is plain `string | undefined` (line 206), so the cast constrains nothing and the lower-case string flows into filter.status, whose declared type is LeaveRequestStatus (leave.types.ts:170). The deeper cause is that hr-module re-declares the whole vocabulary as its own enum at leave.types.ts:28; it happens to agree with the wire today, by hand-maintenance rather than by construction, so nothing stops the next server change from splitting them again. That duplicate declaration is the shared subject of F-015, F-003, F-005, F-007 and F-008. Evidence that proves the result: a green platform-wide npm run type-check (the exhaustiveness assertions execute there) and the new spec asserting the rendered option values are the six UPPER-case contract members plus All Statuses.",
    "coverage": {
      "waivers": [
        {
          "node": "dependents-of:web-hr-module",
          "reason": "The change alters no identifier and no runtime value a reverse dependent can observe. LeaveRequestStatus keeps its name, its six member names and its six runtime strings ('DRAFT'...'WITHDRAWN', verified identical at leave.types.ts:29-34 and graphql-types.ts:8744-8749), and keeps resolving in both type and value position, so every consumer reached through the types barrel (web/modules/hr-module/src/types/index.ts:10) compiles against the same shape. The additions (LEAVE_REQUEST_STATUSES, isLeaveRequestStatus) are new exports no existing consumer reads. The one intended delta is strictly narrowing: assigning an arbitrary string into a LeaveRequestStatus position stops compiling, which is the defect being fixed. This plan's validation set runs npm run type-check, which is platform-wide rather than affected-scoped, so it compiles every reverse dependent against the narrowed type and fails the plan if any consumer is broken. The plan cannot widen paths to these nodes because they lie outside the request's allowed_scope of web/modules/hr-module/**."
        },
        {
          "node": "project:web-shell",
          "reason": "web/shell consumes hr-module as a Module Federation remote rather than through a source import, and this change adds no runtime dependency: the only new cross-package import is a type-only import of the generated union, which erases at compile time and so adds nothing to the federation graph or the shared-deps singleton set governed by web/shared-ui/src/federation/federationSharedConfig.ts. The shell's own sources are outside this request's allowed_scope of web/modules/hr-module/**, and platform-wide npm run type-check in this plan's validation set compiles the shell against the narrowed type."
        }
      ]
    },
    "evidence_refs": [
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:149",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:138",
      "web/modules/hr-module/src/types/leave.types.ts:28",
      "web/modules/hr-module/src/types/leave.types.ts:170",
      "web/modules/hr-module/src/types/leave.types.ts:186",
      "web/modules/hr-module/src/types/index.ts:10",
      "web/modules/hr-module/src/graphql/leave.operations.ts:58",
      "web/modules/hr-module/src/pages/scheduling/__tests__/WeeklySchedulePage.spec.tsx:11",
      "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
      "apps/hr-service/src/leave/entities/leave-request.entity.ts:32",
      "web/shared-ui/src/generated/graphql-types.ts:8743"
    ],
    "finding_id": "F-015",
    "key_changes": [
      {
        "description": "In web/modules/hr-module/src/pages/leaves/LeavesPage.tsx, remove every hand-written status literal and derive the filter from the module's contract-bound vocabulary. (1) Replace the five hard-coded Select options at lines 389-395 with `[{ value: '', label: 'All Statuses' }, ...LEAVE_REQUEST_STATUSES.map((status) => ({ value: status, label: LEAVE_STATUS_CONFIG[status].label }))]`, importing LEAVE_REQUEST_STATUSES and LEAVE_STATUS_CONFIG from '../../types'; this yields all six statuses with wire-valid UPPER-case values and labels that cannot drift from the contract. (2) Change handleFilterChange (line 206) from `(key: keyof LeaveRequestFilterInput, value: string | undefined)` to the key-correlated generic `<K extends keyof LeaveRequestFilterInput>(key: K, value: LeaveRequestFilterInput[K] | undefined): void`, and write the body as `setFilter((prev) => { const next = { ...prev }; next[key] = value || undefined; return next; })` so the assignment typechecks without any cast; the status key then accepts only LeaveRequestStatus | undefined. (3) Replace the inert cast at line 398 with the guard from '../../types': `onChange={(e) => handleFilterChange('status', isLeaveRequestStatus(e.target.value) ? e.target.value : undefined)}`, so the empty 'All Statuses' choice clears the filter exactly as the previous `value || undefined` did. (4) Replace the second cast at line 149, `row.status === ('PENDING' as LeaveRequestStatus)`, with `row.status === LeaveRequestStatus.PENDING`. (5) Leave the status column at line 138 unchanged: LEAVE_STATUS_CONFIG is already exhaustive over all six statuses, so row rendering is correct today and stays correct. The symbols LEAVE_REQUEST_STATUSES and isLeaveRequestStatus are established by key change 2 in leave.types.ts; the two files are one atomic change and the validation suite runs over the completed set. Touches only this file.",
        "id": "OP-F015-20261008-1-key-change-001",
        "paths": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
        ]
      },
      {
        "description": "In web/modules/hr-module/src/types/leave.types.ts, stop re-declaring the leave-request status vocabulary and derive it from the generated contract. Replace `export enum LeaveRequestStatus { DRAFT = 'DRAFT', ... }` (lines 28-35) with: a type-only import `import type { LeaveRequestStatus as LeaveRequestStatusContract } from '@platform/shared-ui/generated/graphql-types';`, the alias `export type LeaveRequestStatus = LeaveRequestStatusContract;`, the tuple `export const LEAVE_REQUEST_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN'] as const satisfies readonly LeaveRequestStatus[];`, a both-directions exhaustiveness assertion `const _statusTupleCoversContract: Exclude<LeaveRequestStatus, (typeof LEAVE_REQUEST_STATUSES)[number]> extends never ? true : false = true;`, a companion value object `export const LeaveRequestStatus = { DRAFT: 'DRAFT', PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED', WITHDRAWN: 'WITHDRAWN' } as const satisfies Record<string, LeaveRequestStatus>;` so existing member-access call sites keep resolving, and the exported guard `export function isLeaveRequestStatus(value: string): value is LeaveRequestStatus { return (LEAVE_REQUEST_STATUSES as readonly string[]).includes(value); }`. Declaring the type and the const object under one name preserves both the type position (lines 111, 134, 170) and the value position (the LEAVE_STATUS_CONFIG computed keys at lines 187-192) with identical member names and identical runtime strings. LEAVE_STATUS_CONFIG at line 186 keeps its `Record<LeaveRequestStatus, ...>` annotation, which now resolves against the generated union, so the compiler requires an entry for every contract member and rejects a non-member key. Before the swap, grep the module for LeaveRequestStatus in both type and value positions and align any site the swap would break at the contract rather than with a cast or a suppression.",
        "id": "OP-F015-20261008-1-key-change-002",
        "paths": [
          "web/modules/hr-module/src/types/leave.types.ts"
        ]
      },
      {
        "description": "Add web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx following the module's existing page-spec convention (web/modules/hr-module/src/pages/scheduling/__tests__/WeeklySchedulePage.spec.tsx:11-22 \u2014 @testing-library/react with vitest and MemoryRouter). Mock '../../hooks' with vi.mock so useCurrentEmployeeId, useLeaveRequests, usePendingLeaveApprovals, useLeaveTypes, useApproveLeaveRequest and useRejectLeaveRequest return inert values, render LeavesPage inside MemoryRouter, click the 'Filters' control to open the filter panel, then assert against the status Select: its option values are exactly ['', 'DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN'] (All Statuses plus the six contract members) and no option value differs from its own upper-case spelling, which fails if a lower-case hand copy returns. Add a direct unit assertion that LEAVE_REQUEST_STATUSES equals the six contract members and that isLeaveRequestStatus accepts every member and rejects 'pending' and 'unknown' \u2014 the two strings that encode this finding's regression. This locks the subject F-015 shares with F-003, F-005, F-007 and F-008 against reintroduction at runtime, on top of the compile-time assertions in key change 2.",
        "id": "OP-F015-20261008-1-key-change-003",
        "paths": [
          "web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx"
        ]
      }
    ],
    "plan_steps_detailed": [
      "1. leave.types.ts (key change 2): grep the module for LeaveRequestStatus in type and value positions to fix the blast radius before editing. Replace the enum at lines 28-35 with the type-only import of the generated union, the exported type alias, the LEAVE_REQUEST_STATUSES tuple under `as const satisfies readonly LeaveRequestStatus[]`, the Exclude<...> extends never assertion, the same-named const value object under `as const satisfies Record<string, LeaveRequestStatus>`, and the exported isLeaveRequestStatus guard. Leave LEAVE_STATUS_CONFIG's annotation at line 186 in place so it now has to be exhaustive over the generated union. Evidence: leave.types.ts:28, leave.types.ts:186, graphql-types.ts:8743. Satisfies: key-change-0 (prerequisite), plan_contract:plan_architectural_tier_missing.",
      "2. LeavesPage.tsx (key change 1), filter options: replace the five literal options at lines 389-395 with the All-Statuses entry spread with LEAVE_REQUEST_STATUSES mapped through LEAVE_STATUS_CONFIG labels. Evidence: LeavesPage.tsx:389. Satisfies: key-change-0.",
      "3. LeavesPage.tsx, the type hole: make handleFilterChange generic in K extends keyof LeaveRequestFilterInput with value typed LeaveRequestFilterInput[K] | undefined, and write the body via a copied object with next[key] assignment so no cast is needed. Evidence: LeavesPage.tsx:206, leave.types.ts:170. Satisfies: key-change-0.",
      "4. LeavesPage.tsx, the two casts: route the Select onChange through isLeaveRequestStatus, mapping a non-member (including the empty All-Statuses value) to undefined; replace the line 149 literal cast with LeaveRequestStatus.PENDING. Evidence: LeavesPage.tsx:398, LeavesPage.tsx:149. Satisfies: key-change-0.",
      "5. Add the page spec (key change 3) with mocked module hooks, MemoryRouter, a click on the Filters control, option-value equality against the six contract members plus the empty entry, a no-lower-case assertion, and guard accept/reject cases for 'pending' and 'unknown'. Evidence: WeeklySchedulePage.spec.tsx:11, LeavesPage.tsx:389. Satisfies: key-change-0.",
      "6. Run the four declared validation commands; every one must exit 0."
    ],
    "provenance_refs": [
      "aria-tools/operator-feedback.jsonl:OP-F015-20261008-1"
    ],
    "recursive_impact": [
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx \u2014 the defect site and the filter UI. Status: known. Contained by the new page spec plus npm run type-check. Gains two options (Draft, Withdrawn) and starts sending wire-valid values; the visible delta is two extra entries in the status Select.",
      "web/modules/hr-module/src/types/leave.types.ts \u2014 the duplicate declaration and the root of the fix. Status: known. Contained by npm run type-check (the Exclude<...> extends never assertion and the Record<LeaveRequestStatus, ...> exhaustiveness on LEAVE_STATUS_CONFIG at line 186) plus npx nx affected --target=test.",
      "web/modules/hr-module/src/types/index.ts \u2014 barrel that re-exports leave.types.ts (line 10), so the status symbol reaches the whole module. Status: known. Member names and runtime strings are unchanged, so consumers resolve the same shape; platform-wide npm run type-check is the containing gate. Not written by this plan.",
      "web/modules/hr-module/src/graphql/leave.operations.ts \u2014 declares $status: LeaveRequestStatus at line 58 and line 100 inside gql template strings, which are GraphQL text rather than TypeScript references. Status: known. No change needed: after the fix the values flowing into $status finally match the enum the document already names. Not written by this plan.",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:138 and the LEAVE_STATUS_CONFIG label map \u2014 read in this run and found already exhaustive over all six statuses (leave.types.ts:187-192), so DRAFT and WITHDRAWN rows render their badges correctly today. Status: known, no defect. This corrects the round-1 challenger premise that status-keyed rendering falls into unknown-status fallbacks; the defect is confined to the filter path.",
      "apps/hr-service/src/leave/entities/leave-request.entity.ts and web/shared-ui/src/generated/graphql-types.ts \u2014 read-only evidence. Status: known. Consumed as contracts, never written; no codegen run, no schema edit, no entity edit, so no migration node enters the closure.",
      "libs/event-contracts/** \u2014 not touched, so no event-consumer node enters the closure. No NATS surface is involved in a client-side filter derivation.",
      "Most extreme affected node: web/shell, which loads hr-module as a federated remote. The only new cross-package import is type-only and erases at compile time, so the federation graph and the shared-deps singleton set are unchanged; the shell lies outside allowed_scope and is covered by platform-wide npm run type-check. Waived in the coverage block with that reason."
    ],
    "risks": [
      {
        "affected_files": [
          "web/modules/hr-module/src/types/leave.types.ts",
          "web/modules/hr-module/src/types/index.ts"
        ],
        "evidence_refs": [
          "web/modules/hr-module/src/types/index.ts:10",
          "web/modules/hr-module/src/types/leave.types.ts:170"
        ],
        "required_plan_changes": "Step 1 greps the module for every LeaveRequestStatus type and value usage before the swap and aligns each site to the contract, never with a cast or a suppression. Platform-wide npm run type-check fails the plan if a site is missed. If a required edit falls outside web/modules/hr-module/**, the plan stops and the request returns for a scope decision rather than reaching for a suppression.",
        "risk_id": "RISK-1",
        "severity": "MEDIUM",
        "summary": "LeaveRequestStatus is barrel-exported module-wide (types/index.ts:10). A consumer outside the leaves page that currently assigns a plain string into a LeaveRequestStatus position compiles today against a string enum only where a cast is present, and will stop compiling against the derived union. That is the fix working, but it can surface edits beyond the three planned files."
      },
      {
        "affected_files": [
          "web/modules/hr-module/src/types/leave.types.ts"
        ],
        "evidence_refs": [
          "web/modules/hr-module/src/types/leave.types.ts:28",
          "web/modules/hr-module/src/types/leave.types.ts:186"
        ],
        "required_plan_changes": "A string enum has no numeric reverse map, so nothing can depend on one; the const object preserves both member names and Object.values contents. Step 1's grep explicitly checks for Object.keys/Object.values use over the symbol, and npx nx affected --target=test plus npm run type-check gate the result.",
        "risk_id": "RISK-2",
        "severity": "MEDIUM",
        "summary": "Replacing an enum with a same-named type alias plus const object preserves type and value positions, but a consumer depending on enum-specific semantics (Object.values ordering, or a numeric reverse mapping) could shift behaviour."
      },
      {
        "affected_files": [
          "web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx"
        ],
        "evidence_refs": [
          "web/modules/hr-module/src/pages/scheduling/__tests__/WeeklySchedulePage.spec.tsx:11",
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206"
        ],
        "required_plan_changes": "Step 5 mocks '../../hooks' with vi.mock and wraps the render in MemoryRouter, following the module's existing page-spec convention, and adds direct non-rendering assertions on LEAVE_REQUEST_STATUSES and isLeaveRequestStatus so the contract lock holds even if the render assertions need provider adjustment.",
        "risk_id": "RISK-3",
        "severity": "LOW",
        "summary": "The new spec renders LeavesPage, which calls six module hooks at render and imports a sibling component for sanitizeColor; an unmocked import or render would fail under the module's vitest runner for reasons unrelated to the finding."
      },
      {
        "affected_files": [
          "web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx"
        ],
        "evidence_refs": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389"
        ],
        "required_plan_changes": "Step 5 clicks the Filters control before querying, and asserts the option count is exactly seven so an empty or partial render fails rather than passing silently.",
        "risk_id": "RISK-4",
        "severity": "LOW",
        "summary": "The status filter panel is conditional on showFilters, so a spec that queries the Select without opening the panel would assert against an absent element and pass vacuously."
      },
      {
        "affected_files": [
          "web/modules/hr-module/src/types/leave.types.ts"
        ],
        "evidence_refs": [
          "web/modules/hr-module/src/types/index.ts:10"
        ],
        "required_plan_changes": "The coverage block waives dependents-of:web-hr-module and project:web-shell, each with the identifier-and-runtime-value-preserved reason and platform-wide npm run type-check named as the covering gate. If the closure names a different node, the next revision widens affected_surfaces where allowed_scope permits and waives it on the same basis otherwise.",
        "risk_id": "RISK-5",
        "severity": "LOW",
        "summary": "The computed impact closure may name reverse dependents of web-hr-module that this plan cannot write, because allowed_scope is limited to web/modules/hr-module/**."
      }
    ],
    "rollback": "git revert the single commit, or restore the three paths individually: `git checkout HEAD -- web/modules/hr-module/src/pages/leaves/LeavesPage.tsx web/modules/hr-module/src/types/leave.types.ts` and `git rm web/modules/hr-module/src/pages/leaves/__tests__/LeavesPage.spec.tsx`. There is no server change, no schema or migration, no generated-code regeneration, no GraphQL document change and no federation-config change to unwind, so the revert is complete and self-contained. Reverting restores the F-015 defect \u2014 two unfilterable statuses and four wire-invalid option values \u2014 which is the honest pre-change state.",
    "schema_version": 2,
    "summary": "The leave-request status vocabulary is declared three times. hr-service declares it once (leave-request.entity.ts:18) and registers it as a GraphQL enum (line 32), so the wire carries the enum KEYS and the generated client union is the six UPPER-case members at graphql-types.ts:8743. hr-module then re-declares the same vocabulary as its own independent enum (leave.types.ts:28), and LeavesPage.tsx hand-copies it a third time as four lower-case Select options (lines 389-395) that mirror the server's persisted values rather than the wire names. The filter is therefore broken in two directions at once: DRAFT and WITHDRAWN have no option at all, and the four values it does offer are not members of the schema enum that GET_LEAVE_REQUESTS types $status against (leave.operations.ts:58). The `as LeaveRequestStatus` cast at line 398 concealed this because handleFilterChange's value parameter is plain `string | undefined` (line 206), so no check ever compared the selected value to the contract. This plan removes both duplicate declarations: the module's status type becomes an alias of the generated union with a both-directions compile-time exhaustiveness assertion, the label Record and the filter options derive from that single tuple, handleFilterChange becomes key-correlated so an arbitrary string cannot reach filter.status, a runtime guard narrows the DOM string so both casts are removed rather than relocated, and a new page spec locks the rendered option set to the contract.",
    "title": "F-015 root fix: derive the hr-module leave status vocabulary from the generated LeaveRequestStatus contract, removing the module's duplicate enum and the page's hand-copied filter options",
    "validation_commands": [
      {
        "cmd": "npm run type-check",
        "expected_exit": 0,
        "timeout_ms": 900000
      },
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
        "cmd": "node tools/quality/quality.mjs format check-changed",
        "expected_exit": 0,
        "timeout_ms": 300000
      }
    ],
    "validation_plan": "npm run type-check is the primary proof and the reason it is listed first: it is platform-wide rather than affected-scoped, and it is where the tier-1 mechanism actually executes \u2014 the `satisfies readonly LeaveRequestStatus[]` constraint, the Exclude<...> extends never exhaustiveness assertion, the Record<LeaveRequestStatus, ...> label-map completeness, and the key-correlated handleFilterChange signature that makes a bare string unassignable to filter.status. It also compiles every reverse dependent of web-hr-module against the narrowed type, which is what makes the two coverage waivers auditable rather than asserted. npx nx affected --target=test runs the new LeavesPage spec, which proves at runtime what the compiler proves statically: the rendered status filter offers All Statuses plus exactly the six UPPER-case contract members, no option carries a lower-case value, and the guard rejects 'pending' and 'unknown' \u2014 so a future hand copy of the server's persisted values fails a test instead of silently breaking the filter. It also runs the existing web-hr-module suite, including LeaveBalanceWidget.spec.tsx, which imports from the same types barrel. npx nx affected --target=lint enforces the repository lint gate over the changed files, including the prohibition on casts and suppressions that this plan removes rather than relocates. node tools/quality/quality.mjs format check-changed enforces the format gate on the three touched files. Mapping to obligations: key-change-0 is proven by the spec's option-set assertions plus the type-check of the page; plan_contract:plan_architectural_tier_missing is proven by the tier claim being present and by type-check executing the tier-1 assertions it names. All four commands are canonical-suite entries from this request's plan contract and all must exit 0."
  },
  "request_id": "AIR-aria-primary-planner-0c41a75a5f21",
  "role": "primary_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
        "web/modules/hr-module/src/types/leave.types.ts:28"
      ],
      "id": "key-change-0",
      "note": "key_changes[0] stays bounded to the single file the obligation lists (web/modules/hr-module/src/pages/leaves/LeavesPage.tsx) and performs exactly the remediation the plan_description names: the leave list status filter stops being a hand-written copy and is derived from the declared contract, so all six statuses including DRAFT and WITHDRAWN become filterable and the emitted value matches the wire enum GET_LEAVE_REQUESTS types $status against. The obligation's description was the operator's prose; this revision restates the same subject as executable steps on the same path. Reading the file in this run established that the vocabulary is additionally re-declared at web/modules/hr-module/src/types/leave.types.ts:28, so the single-source correction lands in key_changes[1] on that separate path, leaving key_changes[0]'s file set unchanged.",
      "verdict": "satisfied"
    },
    {
      "evidence_refs": [
        "web/shared-ui/src/generated/graphql-types.ts:8743",
        "web/modules/hr-module/src/types/leave.types.ts:186"
      ],
      "id": "plan_contract:plan_architectural_tier_missing",
      "note": "plan_content.architectural_tier is now claimed as 1. The mechanism is structural, not advisory: the module's status type becomes an alias of the generated union, the option tuple is constrained by `satisfies readonly LeaveRequestStatus[]`, an Exclude<...> extends never assertion fails the build if the contract gains a member the tuple lacks, Record<LeaveRequestStatus, ...> forces an exhaustive label map, and a key-correlated handleFilterChange signature makes an arbitrary string unassignable to filter.status. All four validation_commands are canonical-suite spellings; npm run type-check is the command that executes the tier-1 assertions.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
