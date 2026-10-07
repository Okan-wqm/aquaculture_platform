{
  "$schema": "aria/agent-response/v1",
  "agent_id": "ci-executor:gha-37691204196",
  "claim_id": "claim_918e107852e055ee",
  "details": {
    "agent_confidence_source": "self_reported",
    "agent_contract_hash": "sha256:3ffe75613eccae71e113d8a6eb7fc7127fdb782c07333c3817ee9e071b5ca4b3",
    "agent_dispatch_model": "opus",
    "agent_subagent_type": "aria-primary-planner",
    "agent_text": "```json\n{\n  \"$schema\": \"aria/agent-response/v1\",\n  \"request_id\": \"AIR-aria-primary-planner-8d2aaa4ea94f\",\n  \"claim_id\": \"AIR-aria-primary-planner-8d2aaa4ea94f\",\n  \"agent_id\": \"aria-primary-planner\",\n  \"role\": \"primary_plan\",\n  \"status\": \"submitted\",\n  \"satisfaction_matrix\": [\n    {\n      \"id\": \"key-change-0\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"Delivered as a single concrete remediation of the F-015 filter defect in web/modules/hr-module/src/pages/leaves/LeavesPage.tsx, with the mechanics stated step-by-step in key_changes[0].description (this answers CR-002, whose complaint was that round 1 restated the operator text and terminated mid-sentence without naming any change). Two adjustments to the obligation's path list, both evidence-driven. First, apps/hr-service/src/leave/entities/leave-request.entity.ts is removed from the step's paths: the step makes no edit to it, and the plan contract defines paths as the files a step touches, so listing a zero-diff file is what manufactured the migration:hr-service closure node in round 1 \u2014 the coverage witness named exactly this removal as a cure. The entity stays in evidence_refs as the read-only conformance anchor. Second, the obligation's plan_description asserts that the web consumes the backend contract as the generated union LeaveRequestStatus from web/shared-ui/src/generated/graphql-types.ts; the file disagrees. LeavesPage.tsx imports LeaveRequestStatus from '../../types', which resolves to a local hand-written enum at web/modules/hr-module/src/types/leave.types.ts:28, and the exhaustive Record LEAVE_STATUS_CONFIG at leave.types.ts:186 is keyed on that local enum and already carries all six statuses with display labels. The remediation therefore derives the option list from vocabulary that already exists in the module rather than introducing a second status-to-label map, which would re-commit the duplication defect this plan exists to remove. The operator's goal \u2014 fix the four hand-typed lower-case options at lines 389-395 at their root \u2014 is met in full; only the stated mechanism is corrected against the files read in this run.\",\n      \"evidence_refs\": [\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389\",\n        \"web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398\",\n        \"web/modules/hr-module/src/types/leave.types.ts:28\",\n        \"web/modules/hr-module/src/types/leave.types.ts:186\",\n        \"web/shared-ui/src/generated/graphql-types.ts:8722\"\n      ]\n    },\n    {\n      \"id\": \"coverage:migration:hr-service\",\n      \"verdict\": \"satisfied\",\n      \"note\": \"The node is answered by removing its only input rather than by re-asserting a waiver the critic already rejected. Per the witness's own reading of the round-1 manifest, migration:hr-service fired solely because apps/hr-service/src/leave/entities/leave-request.entity.ts was pinned in affected_surfaces and in key-change-0's paths. This revision's affected_surfaces contains one path, web/modules/hr-module/src/pages/leaves/LeavesPage.tsx, and no key change lists any apps/hr-service file, so the plan asserts no edit to any *.entity.ts and the closure recomputes with no migration node. No coverage.waivers entry is claimed, so no waiver adjudication can flip the verdict \u2014 which is how round 1 failed. On the substance the witness asked for: the coupling in that entity is value-level and real, and that is precisely why the hr-service diff is empty rather than small. The enum members at leave-request.entity.ts:18 carry lower-case string values; those values are the Postgres enum type behind @Column({ type: 'enum', enum: LeaveRequestStatus }) at line 154, they are indexed by idx_leave_tenant_status at line 68, and the gist EXCLUDE predicate documented above the class embeds three of them literally. registerEnumType at line 32 separately publishes the member NAMES as the GraphQL wire vocabulary. Editing any member would therefore move both DDL and wire contract at once, and libs/backend-common/src/database/sc...",
    "claude_cli_usage": {
      "cache_creation": {
        "ephemeral_1h_input_tokens": 151239,
        "ephemeral_5m_input_tokens": 0
      },
      "cache_creation_input_tokens": 151239,
      "cache_read_input_tokens": 523188,
      "inference_geo": "not_available",
      "input_tokens": 10,
      "iterations": [
        {
          "cache_creation": {
            "ephemeral_1h_input_tokens": 7245,
            "ephemeral_5m_input_tokens": 0
          },
          "cache_creation_input_tokens": 7245,
          "cache_read_input_tokens": 143994,
          "input_tokens": 2,
          "output_tokens": 22516,
          "type": "message"
        }
      ],
      "output_tokens": 47764,
      "output_tokens_details": {
        "thinking_tokens": 31488
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
        "CR-004",
        "CR-005",
        "COV-R1-ad0136d0"
      ],
      "premise_correction": "One round-1 premise shared by the obligation text and both plans is contradicted by the files read in this run and is recorded here because it changes the mechanics rather than the goal. The obligation's plan_description states that the web consumes the backend contract as the generated union LeaveRequestStatus in web/shared-ui/src/generated/graphql-types.ts. LeavesPage.tsx:33 imports LeaveRequestStatus from '../../types', which resolves to a local hand-written enum at web/modules/hr-module/src/types/leave.types.ts:28; the generated module has no re-export anywhere under web/shared-ui/src, so the generated union is not reachable from hr-module through the package surface at all. The challenger's step 2, which assumed the binding was the generated union and would rebind if not, would therefore have required a write to read-only contract surface to complete. The goal is unchanged and fully delivered: the four hand-typed lower-case options are removed at their root and the vocabulary becomes compiler-enforced. The residual local-enum-to-wire-union link is RISK-01, with its cure and its scope blocker named.",
      "resolution_notes": {
        "COV-R1-ad0136d0": "The waiver is withdrawn, not re-argued. The manifest's own finding was that the node fired solely because the entity was pinned in affected_surfaces and key-change-0's paths; this revision pins it in neither, so the closure recomputes without it and no waiver adjudication can reject it. The witness's checkable cure is also answered on the merits: the key-change text states that the step touches one file and that a diff containing any other path is non-conforming, and the drift surface at libs/backend-common/src/database/schema-manager.service.ts:234 is cited as the runtime coupling that makes an unintended entity edit visible as drift with the migration directory untouched.",
        "CR-001": "architectural_tier is declared as 1 and justified structurally. The recommendation to adopt a tier-1 Record-exhaustiveness design is adopted; the specific mechanism is not, because an exhaustive Record over this vocabulary already exists at web/modules/hr-module/src/types/leave.types.ts:186 and is already imported into the page at line 36. Declaring a second status-to-label map would recreate the hand-copied vocabulary this plan removes, so the options derive from Object.values(LeaveRequestStatus) with labels from the existing Record.",
        "CR-002": "The truncated restatement is replaced by five numbered, file-and-line-bounded mechanics in key_changes[0].description plus nine detailed plan steps, each naming the construct to change and the compile error that results if it is skipped.",
        "CR-003": "Resolved by removing the input rather than by waiving: apps/hr-service/src/leave/entities/leave-request.entity.ts is in no key change's paths and not in affected_surfaces, so no migration node is computed and no coverage block is needed. The entity's exact DDL coupling \u2014 enum values behind the enum column at line 154, the index at line 68, the EXCLUDE predicate above the class \u2014 is stated as the reason the hr-service diff is empty.",
        "CR-004": "All four canonical executable commands are declared, with npm run type-check first because it is the proof the tier-1 claim rests on.",
        "CR-005": "The member-by-member cross-check was performed in this planning run across all three vocabularies \u2014 entity enum names at leave-request.entity.ts:18, generated union at graphql-types.ts:8722, local enum values at leave.types.ts:28 \u2014 and they are identical at this SHA. It is also written into plan step 1 as a stop condition that halts on divergence instead of anchoring the derivation on a stale file. The underlying premise is corrected as well: the page consumes the local enum, not the generated union, so the fix no longer anchors on the generated file at all and reads it only as the conformance check."
      }
    },
    "runtime_attempt_ledger_hash": "sha256:e6ce8bc7946914b48273bba0514eef81d0d3bb11b66c01733c5d534d9ff56823"
  },
  "evidence_refs": [
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:149",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206",
    "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:36",
    "web/modules/hr-module/src/types/leave.types.ts:28",
    "web/modules/hr-module/src/types/leave.types.ts:186",
    "web/modules/hr-module/src/types/leave.types.ts:170",
    "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
    "apps/hr-service/src/leave/entities/leave-request.entity.ts:32",
    "apps/hr-service/src/leave/entities/leave-request.entity.ts:68",
    "apps/hr-service/src/leave/entities/leave-request.entity.ts:154",
    "web/shared-ui/src/generated/graphql-types.ts:8722",
    "libs/backend-common/src/database/schema-manager.service.ts:234"
  ],
  "plan_content": {
    "affected_surfaces": [
      {
        "paths": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
        ]
      }
    ],
    "architectural_approach": "Tier 1, make it impossible, bounded honestly to this page's status vocabulary. Three independent compile-time walls replace the single cast that was holding the defect open. First, the option list is generated, not typed: Object.values(LeaveRequestStatus) cannot omit a member or mis-case one, so an incomplete or wrongly-cased filter is structurally unrepresentable rather than merely discouraged. Second, the exhaustive Record LEAVE_STATUS_CONFIG at leave.types.ts:186 is the label source, so if the enum ever gains a seventh member that Record stops compiling until it is updated, and the options array then picks the new member up with no further edit \u2014 the completeness check is the compiler's, and the propagation is automatic. Third, handleFilterChange becomes key-correlated over keyof LeaveRequestFilterInput, which converts the assignment hole into a type error: since LeaveRequestFilterInput['status'] is LeaveRequestStatus, a raw DOM string can no longer reach filter.status at all, which is what makes the type predicate mandatory instead of optional. The only runtime seam is the DOM select yielding string, and it is closed by a predicate over the same Record keys, collapsing any invalid value to the existing All-Statuses sentinel. Deleting both casts, at line 398 and at line 149, is what makes the walls load-bearing: a cast anywhere in this file would re-admit the exact literal the walls exist to reject, which is why the second cast is in scope even though it is not itself a runtime bug. Tier 1 is claimed for this file's status vocabulary and nothing wider. The residual link \u2014 the local enum at leave.types.ts:28 duplicating the generated union with nothing enforcing equality \u2014 is recorded as RISK-01 with its exact cure and the exact reason that cure cannot be written under this plan's scope, rather than being claimed as closed.",
    "architectural_tier": 1,
    "context": "Why this matters, end to end, stated as the cause chain a junior engineer can follow. The backend declares the leave status vocabulary once: enum LeaveRequestStatus at apps/hr-service/src/leave/entities/leave-request.entity.ts:18 has six members whose string VALUES are lower-case (draft, pending, ...). Two different consumers read two different halves of that declaration. The database reads the VALUES: @Column({ type: 'enum', enum: LeaveRequestStatus }) at line 154 makes them a Postgres enum type, idx_leave_tenant_status at line 68 indexes the column, and the gist EXCLUDE constraint documented above the class embeds cancelled, rejected and withdrawn literally. GraphQL reads the NAMES: registerEnumType at line 32 publishes DRAFT, PENDING, APPROVED, REJECTED, CANCELLED, WITHDRAWN as the wire vocabulary, which is what codegen emitted as the union at web/shared-ui/src/generated/graphql-types.ts:8722. The leave list page ignored both and typed a third vocabulary by hand: the Select at LeavesPage.tsx:389-395 offers four lower-case strings and silences the mismatch with 'as LeaveRequestStatus' at line 398. Two failures follow and the cast is why they shipped. DRAFT and WITHDRAWN requests cannot be filtered at all, and the four values the control does offer are not members of the wire enum, so the $status variable fails GraphQL enum coercion and the filter is broken at runtime rather than merely incomplete. One correction to the round-1 reading matters for the fix and is the reason this revision is not a paraphrase of the challenger: the page's LeaveRequestStatus binding is NOT the generated union. Line 33 imports it from '../../types', which resolves to a local enum at web/modules/hr-module/src/types/leave.types.ts:28 whose values are the upper-case wire names, and LEAVE_STATUS_CONFIG at leave.types.ts:186 is already an exhaustive Record over it with every label. The correct fix consumes that existing exhaustive declaration instead of adding a fourth copy of the vocabulary. Line 149 corroborates the diagnosis: 'PENDING' as LeaveRequestStatus is a cast needed only because a string literal was written where an enum member belongs, which is the same suppression in a second place. If this is skipped, the status filter stays broken in production, DRAFT and WITHDRAWN stay unreachable, and the class behind F-003, F-005, F-007, F-008 and F-015 keeps regenerating on every new consumer that types the set by hand. The evidence that proves the result is executable: with both casts deleted and handleFilterChange key-correlated, npm run type-check fails on any lower-case or non-member status literal, so the drift is a build error instead of a silent runtime failure.",
    "evidence_refs": [
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:149",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206",
      "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:36",
      "web/modules/hr-module/src/types/leave.types.ts:28",
      "web/modules/hr-module/src/types/leave.types.ts:186",
      "web/modules/hr-module/src/types/leave.types.ts:170",
      "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
      "apps/hr-service/src/leave/entities/leave-request.entity.ts:32",
      "apps/hr-service/src/leave/entities/leave-request.entity.ts:68",
      "apps/hr-service/src/leave/entities/leave-request.entity.ts:154",
      "web/shared-ui/src/generated/graphql-types.ts:8722",
      "libs/backend-common/src/database/schema-manager.service.ts:234"
    ],
    "finding_id": "F-015",
    "key_changes": [
      {
        "description": "Remediate F-015 (the drift class also cited by F-003, F-005, F-007, F-008) entirely inside web/modules/hr-module/src/pages/leaves/LeavesPage.tsx, in five bounded edits. (1) Move LeaveRequestStatus from the type-only import block at lines 30-35 into the value import from '../../types' at line 36, alongside LEAVE_STATUS_CONFIG: the enum is needed as a value in steps 2 and 4, and leaving it under 'import type' makes those uses a compile error. (2) Add a module-level constant outside the component, beside no new mapping of its own: const LEAVE_STATUS_OPTIONS = [{ value: '', label: 'All Statuses' }, ...Object.values(LeaveRequestStatus).map((status) => ({ value: status, label: LEAVE_STATUS_CONFIG[status].label }))]. Object.values over a string enum is already typed LeaveRequestStatus[], so no type assertion is used, and LEAVE_STATUS_CONFIG at web/modules/hr-module/src/types/leave.types.ts:186 is already an exhaustive Record over that same enum carrying every label this control needs \u2014 do NOT declare a second status-to-label map, which would reintroduce the hand-copied vocabulary this change removes. (3) Replace the hand-written options array literal at lines 389-395 with options={LEAVE_STATUS_OPTIONS}, so all six statuses including DRAFT and WITHDRAWN become filterable and every option value is the enum's own value rather than a typed-by-hand string. (4) Make the filter setter key-correlated: change handleFilterChange at line 206 from (key: keyof LeaveRequestFilterInput, value: string | undefined) to a generic <K extends keyof LeaveRequestFilterInput>(key: K, value: LeaveRequestFilterInput[K] | undefined), leaving its body unchanged; because LeaveRequestFilterInput['status'] is LeaveRequestStatus (leave.types.ts:170) this makes passing a raw string for the 'status' key a compile error, while the leaveTypeId, startDate and endDate callers at lines 412, 436 and 452 keep compiling because those fields are string. Then delete the 'as LeaveRequestStatus' cast on the Select onChange at line 398 and gate the DOM value through a type predicate declared next to LEAVE_STATUS_OPTIONS: const isLeaveRequestStatus = (value: string): value is LeaveRequestStatus => Object.prototype.hasOwnProperty.call(LEAVE_STATUS_CONFIG, value); call handleFilterChange('status', isLeaveRequestStatus(event.target.value) ? event.target.value : undefined), which routes the existing '' All-Statuses sentinel to undefined exactly as the current body's 'value || undefined' already does. (5) Replace row.status === ('PENDING' as LeaveRequestStatus) at line 149 with row.status === LeaveRequestStatus.PENDING, removing the second status cast; after this the file contains no status string literal and no status cast, so no mis-cased value can be reintroduced without failing the build. Verification bound on this step: before editing, confirm Object.values(LeaveRequestStatus) yields exactly DRAFT, PENDING, APPROVED, REJECTED, CANCELLED, WITHDRAWN and that these match the generated union at web/shared-ui/src/generated/graphql-types.ts:8722-8728 member-by-member (verified in sync at this SHA). If they diverge, stop and surface the divergence as evidence instead of editing: write nothing under web/shared-ui/**, which is read-only contract surface, and write no apps/hr-service file. This step touches exactly one file; a diff containing any other path is non-conforming.",
        "id": "OP-F015-20261007-1-key-change-001",
        "paths": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
        ]
      }
    ],
    "plan_steps_detailed": [
      "1. Confirm the three vocabularies before editing anything. Read the enum at apps/hr-service/src/leave/entities/leave-request.entity.ts:18 and record its six member NAMES; read the generated union at web/shared-ui/src/generated/graphql-types.ts:8722 and record its six members; read the local enum at web/modules/hr-module/src/types/leave.types.ts:28 and record its six VALUES. All three sets must be identical: DRAFT, PENDING, APPROVED, REJECTED, CANCELLED, WITHDRAWN (verified in sync at this SHA in the planning run \u2014 this is the member-by-member cross-check CR-005 asked for, and it is a stop condition, not a note). If any set diverges, halt and surface the divergence as evidence: a stale generated file would otherwise anchor the fix on the wrong vocabulary, and neither web/shared-ui/** nor the entity may be written to reconcile it.",
      "2. In LeavesPage.tsx, move LeaveRequestStatus out of the type-only import block at lines 30-35 and into the value import from '../../types' at line 36. Steps 3 and 6 use it as a value; under 'import type' those uses do not compile.",
      "3. Declare the derived option list once, at module level outside the component, next to no new label map: const LEAVE_STATUS_OPTIONS = [{ value: '', label: 'All Statuses' }, ...Object.values(LeaveRequestStatus).map((status) => ({ value: status, label: LEAVE_STATUS_CONFIG[status].label }))]. Object.values over a string enum is already LeaveRequestStatus[], so no assertion is written. LEAVE_STATUS_CONFIG (leave.types.ts:186) is the existing exhaustive owner of status labels and is already imported at line 36 \u2014 reuse is the point of this step; a second map would recreate the defect.",
      "4. Replace the hand-written options array at lines 389-395 with options={LEAVE_STATUS_OPTIONS}. All six statuses become filterable, DRAFT and WITHDRAWN included, and every value is now the enum's own value instead of a hand-typed string.",
      "5. Make the setter key-correlated: change handleFilterChange at line 206 to <K extends keyof LeaveRequestFilterInput>(key: K, value: LeaveRequestFilterInput[K] | undefined), body unchanged. This is the wall that makes the guard mandatory \u2014 LeaveRequestFilterInput['status'] is LeaveRequestStatus (leave.types.ts:170), so a raw string for the 'status' key now fails to compile. Confirm the string-typed callers at lines 412, 436 and 452 still compile, since leaveTypeId, startDate and endDate are string fields.",
      "6. Delete the 'as LeaveRequestStatus' cast at line 398 and close the one runtime seam with a type predicate beside LEAVE_STATUS_OPTIONS: const isLeaveRequestStatus = (value: string): value is LeaveRequestStatus => Object.prototype.hasOwnProperty.call(LEAVE_STATUS_CONFIG, value). Wire it as handleFilterChange('status', isLeaveRequestStatus(event.target.value) ? event.target.value : undefined); the '' sentinel takes the undefined branch, matching what the existing 'value || undefined' body already does for every other filter key.",
      "7. Replace row.status === ('PENDING' as LeaveRequestStatus) at line 149 with row.status === LeaveRequestStatus.PENDING. This cast is not a runtime bug \u2014 the local enum's PENDING value is the wire name \u2014 but it is the same suppression, and leaving it keeps a path by which a mis-cased status literal compiles in this file. After this edit the file holds no status string literal and no status cast.",
      "8. Trace the corrected value forward and confirm the result: filter.status now holds only undefined or a LeaveRequestStatus member whose value is the wire name, so the $status variable satisfies GraphQL enum coercion at the boundary registerEnumType established at entity line 32, and the resolver receives the enum's internal value through that same registration.",
      "9. Keep the diff at one file. Write nothing under apps/hr-service/** \u2014 the entity is a read-only anchor, and its enum values are DDL-coupled through the enum column at line 154, the index at line 68 and the EXCLUDE predicate above the class, so an edit there would be a schema change, not a cleanup. Write nothing under web/shared-ui/**, which is read-only contract surface. A diff containing any path other than web/modules/hr-module/src/pages/leaves/LeavesPage.tsx is non-conforming."
    ],
    "recursive_impact": "Blast radius, traced to the most extreme affected node. Direct change surface: one file, web/modules/hr-module/src/pages/leaves/LeavesPage.tsx, in project web-hr-module (layer 3). Files read and not written: web/modules/hr-module/src/types/leave.types.ts (the local enum at line 28, the exhaustive Record at line 186, the filter input at line 170 \u2014 all consumed as they stand); web/shared-ui/src/generated/graphql-types.ts (the generated union at line 8722, read-only contract surface); apps/hr-service/src/leave/entities/leave-request.entity.ts (the canonical declaration at lines 18-32 plus its DDL coupling at lines 68 and 154, read-only verification anchor). Status: every node known, none unknown, none explicitly blocked, no operator override needed. Entity-to-migration coupling: no *.entity.ts appears in affected_surfaces or in any key change's paths, so the migration:hr-service closure node that blocked round 1 has no input and no waiver is claimed. That removal is the substantive answer, not a relabeling: the coupling in that entity is value-level \u2014 the enum values are a live Postgres enum type (line 154), an index key (line 68) and part of an EXCLUDE predicate \u2014 and libs/backend-common/src/database/schema-manager.service.ts:234 is the surface that turns an unintended entity edit into runtime drift even with the migrations directory untouched, which is precisely why the hr-service diff here is empty rather than small. Event contracts: no path under libs/event-contracts is touched, so no NATS event-consumer node is computed. Most extreme affected node: the GraphQL enum coercion boundary on the hr-service GetLeaveRequests resolver path, reached through the $status variable. This change moves the values crossing that boundary from invalid lower-case strings to the wire names registerEnumType publishes at entity line 32, so the boundary starts accepting what it previously rejected; nothing downstream of it changes shape, and the resolver continues to receive the enum's internal value through the same registration. Validation containing this closure: npm run type-check covers the whole TypeScript graph including the generated union and the local enum; npx nx affected --target=test covers web-hr-module and, through the entity read, the hr-service leave suites named in the repository map.",
    "risks": [
      {
        "affected_files": [
          "web/modules/hr-module/src/types/leave.types.ts",
          "web/shared-ui/src/generated/graphql-types.ts"
        ],
        "evidence_refs": [
          "web/modules/hr-module/src/types/leave.types.ts:28",
          "web/shared-ui/src/generated/graphql-types.ts:8722"
        ],
        "required_plan_changes": "The local enum at leave.types.ts:28 duplicates the wire vocabulary and nothing enforces equality; the two sets are identical at this SHA, verified member-by-member, but a seventh backend status would extend the generated union while the local enum stayed behind, and the page would then silently omit one option instead of sending an invalid one. The structural cure is a type-level conformance assertion in leave.types.ts of the form type AssertTrue<T extends true> = T with AssertTrue<equality of `${LeaveRequestStatus}` and the generated union>, which fails the build on divergence in either direction and emits no runtime code. It cannot be written under this plan's scope: web/shared-ui/src has no re-export of generated/graphql-types anywhere, so the union is not reachable from hr-module through the package surface, and adding that re-export is a write under web/shared-ui/**, which this request designates read-only contract surface. A follow-on obligation is needed whose allowed_scope includes the shared-ui export surface; the alternative detectability route, extending tests/invariants/hr-graphql-fe-be-parity.spec.ts, is likewise not writable here. This plan reduces the exposure from a broken filter to a possible missing option and records the remainder rather than claiming the class is closed.",
        "risk_id": "RISK-01",
        "severity": "HIGH",
        "summary": "The hand-written local enum is still the module's status vocabulary with no compile-time link to the generated wire union; the weld requires a write outside this plan's writable scope."
      },
      {
        "affected_files": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
        ],
        "evidence_refs": [
          "web/modules/hr-module/src/types/leave.types.ts:186",
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:149"
        ],
        "required_plan_changes": "No plan change required; this is the same root as RISK-01 and is covered by its cure. Recorded so the reviewer can see the second consumer of the same coupling: the status badge reads LEAVE_STATUS_CONFIG[row.status] where row.status is typed as the local enum but arrives from GraphQL as a wire string. They coincide at this SHA, which is why the badge renders today; if they ever diverge the lookup yields undefined and the subsequent label read throws rather than degrading. This plan does not change that call site and does not make it worse.",
        "risk_id": "RISK-02",
        "severity": "MEDIUM",
        "summary": "The status badge lookup depends on the same local-enum-equals-wire-name coincidence, so it inherits RISK-01's exposure at a call site this plan leaves unchanged."
      },
      {
        "affected_files": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx"
        ],
        "evidence_refs": [
          "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389"
        ],
        "required_plan_changes": "Enforcement for this fix is the compiler, not a test, so a future edit that reintroduces a cast would pass every suite that exists while silently restoring the defect. A test asserting that the rendered option values equal Object.values(LeaveRequestStatus) plus the sentinel would pin the derivation, and web/modules/hr-module/** is writable under this request's allowed_scope, so a new spec under web/modules/hr-module/src/pages/leaves/__tests__/ is available. It is not added as a step here because that is a second path in a key change the obligation pins to a named file set, and adding it unilaterally repeats the path-widening that CR-003 flagged. If the reviewer wants it in this cycle, it is one additional path on key_changes[0] and no other change to this plan.",
        "risk_id": "RISK-03",
        "severity": "MEDIUM",
        "summary": "No test asserts the option list equals the enum; a reintroduced cast would be caught only by review, and the pinning test is a path this plan does not add on its own."
      },
      {
        "affected_files": [
          "apps/hr-service/src/leave/entities/leave-request.entity.ts"
        ],
        "evidence_refs": [
          "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
          "apps/hr-service/src/leave/entities/leave-request.entity.ts:154"
        ],
        "required_plan_changes": "The key-change-0 obligation data lists the entity under paths and this revision narrows paths to the single file the step touches. The basis is explicit: the plan contract defines paths as the files a step touches, and the coverage witness named dropping the entity from key-change-0's paths as a cure for round 2. If a gate instead requires path-set equality with the obligation data, the entity path must be restored together with a stated zero-diff assertion in the key-change text, and the reviewer should expect migration:hr-service to fire again from that single input \u2014 in which case the answer is the assertion in the key-change text, never a waiver reasserted from a pre-change snapshot, which is how round 1 failed adjudication.",
        "risk_id": "RISK-04",
        "severity": "MEDIUM",
        "summary": "Narrowing key_changes[0].paths to the one file actually edited is the witness's named cure but diverges from the obligation's listed path set, and the two obligations cannot both be met while a zero-diff file stays pinned."
      }
    ],
    "rollback": "The change is one frontend file with no persisted state, no schema change, no migration and no event-contract change, so git revert <commit-sha> of the single commit touching web/modules/hr-module/src/pages/leaves/LeavesPage.tsx restores the prior behaviour exactly, including the prior four-option list. No hr-service rollback exists because the hr-service diff is empty; no database or tenant-schema action is required or possible from this change; no generated file is rewritten, so codegen does not need to be re-run after a revert.",
    "schema_version": 2,
    "summary": "The hr-module leave list filter at web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389-398 hand-types four lower-case status strings and casts them with 'as LeaveRequestStatus', so DRAFT and WITHDRAWN cannot be filtered and every value the control does offer fails GraphQL enum coercion, because the wire vocabulary published by registerEnumType at apps/hr-service/src/leave/entities/leave-request.entity.ts:32 is the upper-case member NAMES, which the generated union at web/shared-ui/src/generated/graphql-types.ts:8722 confirms. Reading the page in this run corrects both round-1 plans on one load-bearing point: its LeaveRequestStatus does not resolve to that generated union but to a local enum at web/modules/hr-module/src/types/leave.types.ts:28, whose values are the correct wire names and over which LEAVE_STATUS_CONFIG at leave.types.ts:186 is already an exhaustive six-member Record with display labels, imported into the page at line 36. The fix therefore adds no second status-to-label map: it generates the options from Object.values(LeaveRequestStatus) with labels from that existing Record, makes handleFilterChange at line 206 key-correlated so a bare string can no longer reach filter.status, replaces the raw cast with a type predicate over the same Record, and replaces the 'PENDING' literal cast at line 149 with the enum member \u2014 after which no status string literal and no status cast survive in the file and a mis-cased or missing option is a compile error. The change is confined to one frontend file in one project, so no hr-service file is edited, no *.entity.ts is pinned, and the migration:hr-service closure node that blocked round 1 no longer fires or needs a waiver.",
    "title": "F-015 root cause: generate the LeavesPage status filter from the leave status enum, key-correlate handleFilterChange, and delete both status casts",
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
    "validation_plan": "The primary proof matches the tier-1 claim and is compile-time: npm run type-check must pass with both casts deleted and handleFilterChange key-correlated. This is a real oracle rather than a ritual, because the generic signature is what makes the failure mode visible \u2014 with it in place, any lower-case literal, any non-member status value, and any omission of the type predicate on the Select onChange is a type error, and the error can only be cleared by supplying a genuine LeaveRequestStatus. A cast would silence it, which is exactly why step 6 and step 7 delete the two that exist and step 9 forbids reintroducing one. npx nx affected --target=test exercises the web-hr-module suites and, through the read of the entity and the leave module, the hr-service leave suites the repository map names (leave.integration.spec.ts, leave-admin-ops.spec.ts, leave-ownership.spec.ts, create-leave-request.handler.spec.ts, plus the attendance and scheduling specs that cover the entity), guarding the GetLeaveRequests filter path. npx nx affected --target=lint holds the repository lint gates, including the no-cast and no-console rules this change must not violate. node tools/quality/quality.mjs format check-changed holds the enforced format gate on the single changed file. Mapping to obligations: key-change-0 is proved by type-check plus lint passing on a diff limited to LeavesPage.tsx; coverage:migration:hr-service is proved by the diff containing no apps/hr-service path, which the closure recomputation reads directly; plan_contract:plan_architectural_tier_missing is proved by the declared tier and by all four declared commands belonging to the canonical executable suite."
  },
  "request_id": "AIR-aria-primary-planner-8d2aaa4ea94f",
  "role": "primary_plan",
  "satisfaction_matrix": [
    {
      "evidence_refs": [
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:389",
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
        "web/modules/hr-module/src/types/leave.types.ts:28",
        "web/modules/hr-module/src/types/leave.types.ts:186",
        "web/shared-ui/src/generated/graphql-types.ts:8722"
      ],
      "id": "key-change-0",
      "note": "Delivered as a single concrete remediation of the F-015 filter defect in web/modules/hr-module/src/pages/leaves/LeavesPage.tsx, with the mechanics stated step-by-step in key_changes[0].description (this answers CR-002, whose complaint was that round 1 restated the operator text and terminated mid-sentence without naming any change). Two adjustments to the obligation's path list, both evidence-driven. First, apps/hr-service/src/leave/entities/leave-request.entity.ts is removed from the step's paths: the step makes no edit to it, and the plan contract defines paths as the files a step touches, so listing a zero-diff file is what manufactured the migration:hr-service closure node in round 1 \u2014 the coverage witness named exactly this removal as a cure. The entity stays in evidence_refs as the read-only conformance anchor. Second, the obligation's plan_description asserts that the web consumes the backend contract as the generated union LeaveRequestStatus from web/shared-ui/src/generated/graphql-types.ts; the file disagrees. LeavesPage.tsx imports LeaveRequestStatus from '../../types', which resolves to a local hand-written enum at web/modules/hr-module/src/types/leave.types.ts:28, and the exhaustive Record LEAVE_STATUS_CONFIG at leave.types.ts:186 is keyed on that local enum and already carries all six statuses with display labels. The remediation therefore derives the option list from vocabulary that already exists in the module rather than introducing a second status-to-label map, which would re-commit the duplication defect this plan exists to remove. The operator's goal \u2014 fix the four hand-typed lower-case options at lines 389-395 at their root \u2014 is met in full; only the stated mechanism is corrected against the files read in this run.",
      "verdict": "satisfied"
    },
    {
      "evidence_refs": [
        "apps/hr-service/src/leave/entities/leave-request.entity.ts:18",
        "apps/hr-service/src/leave/entities/leave-request.entity.ts:32",
        "apps/hr-service/src/leave/entities/leave-request.entity.ts:154",
        "apps/hr-service/src/leave/entities/leave-request.entity.ts:68",
        "libs/backend-common/src/database/schema-manager.service.ts:234",
        "web/shared-ui/src/generated/graphql-types.ts:8722"
      ],
      "id": "coverage:migration:hr-service",
      "note": "The node is answered by removing its only input rather than by re-asserting a waiver the critic already rejected. Per the witness's own reading of the round-1 manifest, migration:hr-service fired solely because apps/hr-service/src/leave/entities/leave-request.entity.ts was pinned in affected_surfaces and in key-change-0's paths. This revision's affected_surfaces contains one path, web/modules/hr-module/src/pages/leaves/LeavesPage.tsx, and no key change lists any apps/hr-service file, so the plan asserts no edit to any *.entity.ts and the closure recomputes with no migration node. No coverage.waivers entry is claimed, so no waiver adjudication can flip the verdict \u2014 which is how round 1 failed. On the substance the witness asked for: the coupling in that entity is value-level and real, and that is precisely why the hr-service diff is empty rather than small. The enum members at leave-request.entity.ts:18 carry lower-case string values; those values are the Postgres enum type behind @Column({ type: 'enum', enum: LeaveRequestStatus }) at line 154, they are indexed by idx_leave_tenant_status at line 68, and the gist EXCLUDE predicate documented above the class embeds three of them literally. registerEnumType at line 32 separately publishes the member NAMES as the GraphQL wire vocabulary. Editing any member would therefore move both DDL and wire contract at once, and libs/backend-common/src/database/schema-manager.service.ts:234 records the rule that makes that visible at runtime: every table an @Entity declares must be registered before deploy, and the drift validator compares entity definitions against live schema, so an unintended entity edit surfaces as drift even with the migrations directory untouched. The frontend fix needs none of it: the option values this plan emits are the generated wire names, which I verified member-by-member against the entity enum names in this run.",
      "verdict": "satisfied"
    },
    {
      "evidence_refs": [
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:206",
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:398",
        "web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:149",
        "web/modules/hr-module/src/types/leave.types.ts:186"
      ],
      "id": "plan_contract:plan_architectural_tier_missing",
      "note": "plan_content.architectural_tier is declared as 1, the refused entry named by the gate. The claim is justified structurally, not by assertion: after this change the only way to write filter.status is to supply a LeaveRequestStatus member, because handleFilterChange at LeavesPage.tsx:206 becomes key-correlated over keyof LeaveRequestFilterInput, so passing the raw DOM string for the 'status' key is a compile error rather than a silent coercion failure; the option list is generated from Object.values(LeaveRequestStatus) instead of typed by hand, so a missing or mis-cased option is unrepresentable; the exhaustive Record at leave.types.ts:186 fails to compile if the enum gains a member; and both 'as LeaveRequestStatus' casts that suppressed all of this \u2014 the filter cast at line 398 and the 'PENDING' literal cast at line 149 \u2014 are deleted, leaving no status string literal in the file. The single runtime seam, a DOM select yielding string, is closed by a type predicate over the same Record keys. validation_commands declares all four entries of the canonical executable suite, which also answers CR-004: npm run type-check is the proof this tier claim rests on.",
      "verdict": "satisfied"
    }
  ],
  "status": "submitted"
}
