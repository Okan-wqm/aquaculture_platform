# ARIA Canonical Response Envelope (Plan ARIA-V8 + V8.1 + V8.2 + V8.3 + V8.4)

Single source of truth for the agent response envelope shape that the
ARIA kernel state machine + plan_convergence bridge accept. Referenced
by `aria-primary-planner`, `aria-challenger-planner`, AND
`aria-cross-reviewer` agent prompts; all three produce envelopes that
conform to the schema defined here.

The kernel validators that enforce this shape:

- `plan_convergence._validate_plan_content` — top-level required-fields check
- `plan_convergence._normalize_challenger_plan` — extracts plan_content from challenger payload
- `plan_contract.plan_contract_violations` — the plan contract (`architectural_tier` +
  admissible `validation_commands`), refused at `submit_claim_result`, at
  `plan_convergence.submit_challenger_plan` / `record_revision`, and as the
  `plan_contract_complete` gate row `evaluate_plan` records before CONVERGED
- `ci_executor._pre_submit_validate_envelope` — fail-fast operator-side gate (calls the kernel's plan-contract check)
- `ci_executor._canonicalize_plan_content` — V8.4 normalizer auto-fills missing fields from compatible sources

## Required plan_content fields

The agent's response envelope carries a top-level `plan_content` object.
The kernel requires seven fields with the rules below, plus the
`architectural_tier` claim of the plan contract (next section) on every
agent-authored body.

| Field                 | Type   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`      | int    | Current value: `2`. Version semantics: `1` = legacy (coverage gate inert — all recorded history); `2`+ = the plan-coverage gate applies: the kernel refuses CONVERGED until the deterministic impact-closure verdict (`coverage_computed`, produced by `tools/gates/plan-coverage-witness.ts` via `aria_kernel/plan_coverage.py`) is `covered` or `covered_with_waivers`. Applicability is anchored to the `plan_started` content — a later revision cannot downgrade it. |
| `title`               | string | Non-empty; one-line summary of the plan                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `summary`             | string | Non-empty; 2–5 sentence narrative                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `affected_surfaces`   | array  | Each entry is `{paths: [<repo-relative POSIX>...]}` — no leading `/`, no `\`, no `..`                                                                                                                                                                                                                                                                                                                                                                                     |
| `key_changes`         | array  | Non-empty list of strings; each maps to one numbered plan step                                                                                                                                                                                                                                                                                                                                                                                                            |
| `validation_commands` | array  | Each entry is `{cmd: <non-empty string>, expected_exit?: int, timeout_ms?: int}` or `{recipe_id: <registered recipe>}`; `cmd` must name one of the admissible commands in the request's `plan_contract` block (matched after whitespace is collapsed; the bare `nx ...` form of a canonical command is read as its `npx nx ...` spelling — plan contract, below)                                                                                                          |
| `evidence_refs`       | array  | Each entry MUST be `<repo-relative path>[:<line>]` resolvable to an existing file at the workspace SHA. To cite a finding as evidence, use the path form `aria-findings/F-NNN.json[:<line>]` — bare finding ids (`F-019`) are rejected by `evidence_validator._check_agent_ref` because they do not resolve to a file.                                                                                                                                                    |

Extra plan_content keys are passed through and ignored by the kernel
validator (operator-readable narrative survives). Recommended extras
for forensic detail: `recursive_impact`, `architectural_approach`,
`plan_steps_detailed`, `rollback`, `risks`.

## Plan contract (`aria_kernel/plan_contract.py`)

What a plan body must carry before the kernel accepts it and before it may
CONVERGE — rendered into every planning envelope as the `plan_contract`
block (and the `## Plan contract` prompt section) from the kernel constants
and THIS store's recipe registry, and appended to every delivered agent
contract by `agent_contract.render_response_validator_contract`. The rule
here is the rule the refusal names; the first native CONVERGED plan (trial
ten, 2026-09-12) died at staging because no contract had stated either.

- `plan_content.architectural_tier` is REQUIRED and must be one of
  `change_ledger.ARCHITECTURAL_TIERS` (1 | 2 | 3 | 4), the CLAUDE.md
  architectural-solution hierarchy: 1 make it impossible, 2 make it
  automatic, 3 make it detectable, 4 document it. Staging records the tier
  as YOUR claim about the fix and refuses to author one on your behalf.
- Every `plan_content.validation_commands[]` entry is either `{cmd}`
  naming one of the admissible commands (matched after whitespace is
  collapsed; the bare `nx ...` form of a canonical command is read as its
  `npx nx ...` spelling) — the canonical executable suite
  (`implementation_safety.CANONICAL_VALIDATION_COMMANDS_EXECUTABLE`:
  `npx nx affected --target=test`, `npx nx affected --target=lint`,
  `npm run type-check`) plus the recipes registered on this store
  (`experiment.register_recipe`, listed in the envelope's
  `plan_contract.validation_commands.recipes`) — or `{recipe_id}` naming a
  registered recipe. Any other command is refused: the lane executes it
  outside the implementer sandbox, so the set is operator-declared, never
  plan-declared.
- Refusal reasons, in the vocabulary the kernel and the executor emit:
  `plan_architectural_tier_missing`, `plan_architectural_tier_invalid`,
  `plan_validation_command_not_declared`, `plan_validation_recipe_unknown`.
  A violating envelope is REJECTED at submit (released for retry) and a
  body that reaches evaluation without the contract fails the
  `plan_contract_complete` gate row, so the next primary revision envelope
  carries each violation as a `plan_contract:<reason>` must_satisfy item.

### Optional `coverage` block (schema_version >= 2)

```json
"coverage": {
  "waivers": [
    {"node": "project:notification-service", "reason": "type-only change; consumer rebuild has no behavior delta"},
    {"node": "dependents-of:farm-shared", "reason": "verified via tsc closure — no runtime surface touched"}
  ]
}
```

The machine computes the impact closure of your `affected_surfaces`
(nx reverse dependents at `project:<name>`, NATS consumers at
`event-consumer:<svc>:<EventType>` when `libs/event-contracts/**` is
touched, `migration:<svc>` when an `*.entity.ts` is touched). Every
closure node must either be REACHED by your paths or WAIVED here with
a reason a reviewer can audit. Unwaived nodes come back as
`must_satisfy` items of kind `coverage_gap` (id `coverage:<node_id>`)
and as round-scoped `COV-R{N}-*` material risks — respond by widening
`affected_surfaces` or adding the waiver, never by restating prose.
Waivers live in plan_content (not the event) so they flow through
`content_hash`, revisions, and cross-review like any other plan claim.

Waivers are adjudicated: when a round's computed verdict is
`covered_with_waivers`, the drainer dispatches `aria-completeness-critic`
(role `completeness_critique`), whose envelope answer at
`details.waiver_adjudication` (`{"accepted": [node_id...], "rejected":
[{node_id, reason}...]}`) is folded into the `coverage_computed` event.
Any waived node the critic does not explicitly accept flips to uncovered
(`waiver_rejected_by_critic` / `waiver_unadjudicated`) — critic timeout
fails closed to `gaps`.

## Envelope skeleton

```json
{
  "$schema": "aria/agent-response/v1",
  "request_id": "<from request>",
  "claim_id": "<from request>",
  "agent_id": "aria-primary-planner | aria-challenger-planner",
  "role": "primary_plan | challenger_plan",
  "status": "submitted",
  "satisfaction_matrix": [
    {
      "id": "<must_satisfy.id>",
      "verdict": "satisfied | blocked | contradicted",
      "note": "<why — REQUIRED for blocked | contradicted>",
      "evidence_refs": ["<REQUIRED, non-empty, for blocked | contradicted>"]
    }
  ],
  "evidence_refs": ["..."],
  "plan_content": {
    "schema_version": 2,
    "title": "<one line>",
    "summary": "<2-5 sentences>",
    "affected_surfaces": [{ "paths": ["..."] }],
    "key_changes": ["..."],
    "validation_commands": [
      { "cmd": "npx nx affected --target=test", "expected_exit": 0, "timeout_ms": 1800000 },
      { "recipe_id": "<a recipe_id from plan_contract.validation_commands.recipes>" }
    ],
    "evidence_refs": ["..."],
    "architectural_tier": 2
  },
  "details": {}
}
```

`agent_contract.validate_response` is the authority on this shape: one
entry per `must_satisfy[].id` (no extras, no duplicates); `blocked` and
`contradicted` entries carry `note` (the reason) and a non-empty
`evidence_refs[]`, and a banned phrase in `note` rejects the envelope. The
validator renders these rules itself at the end of every delivered agent
contract (`agent_contract.render_response_validator_contract`).

## Cross-review envelope shape

For `role = "cross_review"`, the canonical payload lives at
`details.cross_review` and is bidirectional (covers both primary and
challenger). The kernel uses `submit_cross_review_v8` to synthesize the
two-task state machine flow from a single agent submission.

```json
{
  "$schema": "aria/agent-response/v1",
  "role": "cross_review",
  "request_id": "<from request>",
  "claim_id": "<from request>",
  "agent_id": "aria-cross-reviewer",
  "status": "submitted",
  "satisfaction_matrix": [...],
  "evidence_refs": ["..."],
  "details": {
    "cross_review": {
      "reviewer_agent": "aria-cross-reviewer",
      "verdict": "agreed | material_risks_present | partial_coverage",
      "verdicts": {
        "primary_to_challenger": "agreed",
        "challenger_to_primary": "material_risks_present"
      },
      "risks": [
        {
          "risk_id": "CR-001",
          "risk_category": "scope_drift",
          "severity": "blocking",
          "summary": "<one line — concise problem statement>",
          "recommendation": "<concrete action the plan author should take>",
          "affected_files": ["apps/path/to/file.ts"],
          "evidence_refs": ["apps/path/to/file.ts:42"],
          "applies_to_direction": "challenger_to_primary"
        }
      ]
    }
  }
}
```

Each `risks[]` entry is structurally validated by
`plan_convergence._validate_cross_review_risk` (in plan_convergence.py). Every
field above is REQUIRED and non-empty EXCEPT `applies_to_direction`,
which is OPTIONAL: it routes the risk to ONE direction record
(`primary_to_challenger` | `challenger_to_primary` | `both`; omitted =
`both`). Attribute each risk to the side it indicts — an unattributed
risk counts against BOTH plans and dilutes the duel-rating signal.
The optional top-level `verdicts` map likewise carries per-direction
verdicts; the scalar `verdict` is the both-directions fallback. The
validator rejects any risk entry with a missing or empty value. Allowed
`severity` values: `{"blocking", "material", "nice_to_have"}` OR
the canonical `KNOWN_SEVERITIES` set `{"HIGH", "MEDIUM", "LOW"}`.
`risk_category` is a free-text classifier — common values include
`scope_drift`, `test_gap`, `architectural_violation`,
`security_regression`, `performance_regression`, `contract_break`.

## V8.4 normalizer (ci_executor) — what gets auto-filled

The ci_executor canonical normalizer fills missing fields from
compatible sources WITHIN the envelope, never from fabricated values:

- `plan_content.evidence_refs` ← copied from envelope top-level `evidence_refs` when missing inside plan_content
- `plan_content.schema_version` ← defaulted to `1` when missing
- `plan_content.affected_surfaces` ← when a flat list of strings, wrapped as `[{paths: [...]}]`
- `plan_content.validation_commands` ← bare strings wrapped as `{cmd, expected_exit: 0, timeout_ms: 60000}`

The normalizer never fabricates evidence. If no `evidence_refs` exist
anywhere in the envelope, the validator rejects the envelope rather
than emitting an empty list. Refer to ci_executor invariants
I-V8.4-NORM-01..07.

## Behavior on schema drift

If the agent produces non-canonical shape:

1. ci_executor normalizer attempts auto-fill from compatible envelope sources.
2. If still non-canonical, ci_executor releases the claim with `reason=plan_content_invalid:<missing_or_malformed_fields>`.
3. Consumer re-dispatches; agent re-runs; new attempt.
4. After repeated non-canonical attempts, the kernel auto-promotes the envelope to HUMAN_REQUIRED.

The kernel state machine never sees a non-canonical envelope — the
ci_executor + bridge pre-validation gates intercept every drift before
submit-result. This contains agent non-determinism at the adapter
boundary and keeps the kernel domain core strict.

## Anchors for invariants

- I-V8.0-07 — orchestrator forwards `--challenger-timeout-seconds` + `--max-rounds`
- I-V8.1-01..05 — agent file location + bridge canonicalize helper
- I-V8.2-CR-01..05 — submit_cross_review_v8 state transition
- I-V8.3-CONTENT-01..03 — drainer envelope content from kernel state
- I-V8.4-NORM-01..07 — ci_executor canonical normalizer

## Ad-hoc / interactive dispatch profile (K6)

Agents whose frontmatter declares `dispatch: ad-hoc` (the acceptance lane:
`aria-acceptance-lead`, `aria-acceptance-output-validator`,
`aria-acceptance-gap-hunter`, `aria-acceptance-gap-fixer`) are dispatched
through the interactive Agent tool, NOT the kernel queue: they are outside
`agent_surface.DEFAULT_TARGET_AGENT_WHITELIST` and `ROLE_TARGET_PAIRING` by
design, and no kernel module mints envelopes for them.

The output contract still binds. Interactive-lane results MUST be shaped as
`aria/agent-response/v1` (satisfaction entries use the closed verdict set
`satisfied | blocked | contradicted`, with `note` + `evidence_refs` on
`blocked`/`contradicted`), and refusals as `aria/agent-refusal/v1`
(`reason_class ∈ law | scope | evidence | safety`). Identity fields the
kernel would normally mint (`request_id`, `claim_id`) are synthesized by the
dispatching lead and recorded in its decision log, so acceptance-lane
outputs can be validated with `agent_contract.validate_response` and read on
the same schema as every kernel-queued result.

The maintenance genesis lane has one additional wire format:
`aria-drafter` refusals are the literal `DRAFTER_REFUSAL:<reason_code>`
sentinel at `--output-path` (I-V3-00a contract). The kernel parses the
sentinel (`draft_validator.parse_drafter_refusal`) and renders the
corresponding `aria/agent-refusal/v1` row into the governance ledger
(`drafter_refusal_recorded`), so drafter refusals are queryable on the same
refusal surface without changing the locked CLI-args contract.
