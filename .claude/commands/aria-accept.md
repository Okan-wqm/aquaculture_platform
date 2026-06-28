---
description: Run the ARIA acceptance lane — validate ARIA's outputs against repo evidence (deterministic) + audit ARIA for gaps. Plan 030.
---

# ARIA Acceptance & Gap-Closure

Validates ARIA's outputs and audits it for gaps. The accept/reject verdict is
DETERMINISTIC (repo evidence), not an LLM opinion; the agent layer only adds
judgment. Fixes are review-gated — never auto-merged.

Plan: `docs/aria/plans/030-acceptance-and-gap-closure-lane.md`.
Harness: `tools/aria-acceptance/harness.py`.

## What you should do

1. Run the deterministic harness (the truth gate — no LLM):

```
python3 tools/aria-acceptance/harness.py
```

Exit 0 = ACCEPT, exit 1 = REJECT. It reports: drift TP/FP/unverifiable, the
isolated-cycle invariants, and the scenario reactions.

2. Dispatch `aria-acceptance-lead` (the project lead) via the Agent tool. It will:
   - have `aria-acceptance-output-validator` interpret borderline drifts (e.g. a
     true-positive that cites an archived migration),
   - have `aria-acceptance-gap-hunter` audit ARIA for blind spots,
   - decide ACCEPT/REJECT and sequence any gap closure.

3. For each validated gap the lead approves, dispatch `aria-acceptance-gap-fixer`
   with ONE finding. It opens a **draft PR** with a root-cause fix + test and
   stops — a human approves the merge.

Do not let an agent's verdict overturn the deterministic harness result silently:
record the gate verdict AND the agent's lead annotation side by side.
