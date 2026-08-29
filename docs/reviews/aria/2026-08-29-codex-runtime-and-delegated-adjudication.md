# ARIA review — 2026-08-29: Codex as a third runtime; a senior-engineer adjudicator for the human gate

Operator requirements (2026-08-29):

1. Add Codex (OpenAI CLI) to the fleet — as a runtime alongside the Claude
   CLI path, usable as a CLI executor.
2. A senior-software-engineer agent that decides IN PLACE of the human at
   the approval gates — thinking like a professional engineer, no human
   sign-off per decision.

## Design direction — Codex runtime

The multi-provider foundation already exists (Z.ai proved the pattern):
`VALID_MODELS`/`MODEL_TIER_ORDER` for the vocabulary, `budget.py` rates,
`PROVIDER_REDIRECTS` for credential routing, per-spawn env scoping. Codex
is NOT Anthropic-protocol, so the honest integration is a sibling executor
bridge (the `worker_executor`/`ci_executor` pattern): a `codex_executor`
that dispatches role requests to the Codex CLI inside the existing
sandbox/kill-switch/lease machinery and maps its output into the same
evidence + satisfaction-matrix + dispatch-stamp contract. Cross-provider
auth failover (ARIA-HIGH-023, merged) then covers a THREE-provider world:
Claude absent → glm; both absent → codex; one alive → the lane works.

## Design direction — delegated adjudication

The mission document bars removing human approval, and explicitly reserves
changing that to the operator — this request IS that operator decision.
The professional shape is class-scoped delegation, not blanket autonomy:

- `policy_approval.py` / `autonomy_unlock.py` / `risk_policy.py` already
  model authority classes; an operator policy ref (like the failover one)
  delegates HUMAN_REQUIRED decisions for DEFINED risk classes to a
  senior-adjudicator agent running at the strongest authoring tier.
- Every adjudication carries the full decision contract: pedagogy block,
  satisfaction matrix per criterion, repo-verified evidence (the
  ARIA-HIGH-022 chain), calibration history, and the policy ref.
- One-way doors (merge to main, deletions, secret surfaces) remain
  human-gated unless the operator separately delegates each class —
  reversible decisions automate first, irreversible ones last.

## ARIA-MEDIUM-027 — Codex runtime and delegated adjudication are designed but not implemented

Both are architecture extensions on proven foundations; neither blocks
the current producer-lane closure. Implementation order: codex_executor
bridge + vocabulary, then the adjudicator policy class + calibration
wiring.
