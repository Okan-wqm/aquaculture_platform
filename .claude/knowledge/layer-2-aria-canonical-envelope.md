# ARIA Canonical Response Envelope (Plan ARIA-V8 + V8.1 + V8.2 + V8.3 + V8.4)

Single source of truth for the agent response envelope shape that the
ARIA kernel state machine + plan_convergence bridge accept. Referenced
by `aria-primary-planner`, `aria-challenger-planner`, AND
`aria-cross-reviewer` agent prompts; all three produce envelopes that
conform to the schema defined here.

The kernel validators that enforce this shape:

- `plan_convergence._validate_plan_content` — top-level required-fields check
- `plan_convergence._normalize_challenger_plan` — extracts plan_content from challenger payload
- `ci_executor._pre_submit_validate_envelope` — fail-fast operator-side gate
- `ci_executor._canonicalize_plan_content` — V8.4 normalizer auto-fills missing fields from compatible sources

## Required plan_content fields

The agent's response envelope carries a top-level `plan_content` object.
The kernel requires seven fields with the rules below.

| Field | Type | Rule |
|---|---|---|
| `schema_version` | int | Current value: `1` |
| `title` | string | Non-empty; one-line summary of the plan |
| `summary` | string | Non-empty; 2–5 sentence narrative |
| `affected_surfaces` | array | Each entry is `{paths: [<repo-relative POSIX>...]}` — no leading `/`, no `\`, no `..` |
| `key_changes` | array | Non-empty list of strings; each maps to one numbered plan step |
| `validation_commands` | array | Each entry is `{cmd: <non-empty string>, expected_exit?: int, timeout_ms?: int}` |
| `evidence_refs` | array | Each entry MUST be `<repo-relative path>[:<line>]` resolvable to an existing file at the workspace SHA. To cite a finding as evidence, use the path form `aria-findings/F-NNN.json[:<line>]` — bare finding ids (`F-019`) are rejected by `evidence_validator._check_agent_ref` because they do not resolve to a file. |

Extra plan_content keys are passed through and ignored by the kernel
validator (operator-readable narrative survives). Recommended extras
for forensic detail: `recursive_impact`, `architectural_approach`,
`plan_steps_detailed`, `rollback`, `risks`.

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
      "evidence_refs": ["..."],
      "evidence": "narrative"
    }
  ],
  "evidence_refs": ["..."],
  "plan_content": {
    "schema_version": 1,
    "title": "<one line>",
    "summary": "<2-5 sentences>",
    "affected_surfaces": [{"paths": ["..."]}],
    "key_changes": ["..."],
    "validation_commands": [{"cmd": "...", "expected_exit": 0, "timeout_ms": 60000}],
    "evidence_refs": ["..."]
  },
  "details": {}
}
```

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
      "risks": [
        {
          "risk_id": "CR-001",
          "risk_category": "scope_drift",
          "severity": "blocking",
          "summary": "<one line — concise problem statement>",
          "recommendation": "<concrete action the plan author should take>",
          "affected_files": ["apps/path/to/file.ts"],
          "evidence_refs": ["apps/path/to/file.ts:42"]
        }
      ]
    }
  }
}
```

Each `risks[]` entry is structurally validated by
`plan_convergence._validate_cross_review_risk` (in plan_convergence.py). Every
field above is REQUIRED and non-empty; the validator rejects any
risk entry with a missing or empty value. Allowed
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
