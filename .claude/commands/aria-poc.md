---
description: Run the ARIA Phase-1 PoC — pure-mechanical operator decision tool. No LLM calls.
---

# ARIA Phase-1 PoC

Pure-mechanical analysis of the repository to answer: **"do we actually need ARIA?"**

Spec: `docs/aria/CONTRACTS.md` §13. Implementation: `tools/aria-poc/poc.py`.

## What you should do

1. Run the PoC mechanically (no Claude analysis needed):

```
python3 tools/aria-poc/poc.py --workspace-root .
```

2. After it completes, read the report:

```
.aria-poc/aria-poc-report.md
```

3. Surface the four decision-gate questions to the operator. Do **not** answer them yourself — these are operator judgment calls that depend on knowledge outside the repository (LLM budget, organizational priorities, prior agent ROI).

4. Show the operator the top 5 TS/SQL drift candidates from `.aria-poc/MECHANICAL_DRIFTS.json` so they can sanity-check whether the PoC found anything novel vs. what the existing specialized agents would have caught. Also report `summary`, `ui_option_groups` promotion counts, and any clustered `frontend_dropdown_drifts`; UI groups are raw evidence, not findings.

## Constraints

- **Zero LLM calls** during the PoC run itself. The PoC is mechanical Python.
- **Do not over-interpret candidates** — you are running the tool, not deciding architecture. The operator interprets.
- **Do not propose fixes** for drifts found. The PoC is a decision gate, not a remediation pass.
- **Do not commit** `.aria-poc/` outputs (already gitignored).

## If the PoC fails

- Python missing: report version and exit. Don't try to install anything.
- `pyyaml` missing: PoC degrades gracefully (agent priors will use first-paragraph fallback). No action needed.
- `npx nx graph` failing: PoC continues without `BUILD_GRAPH.json`. Note in your summary.
- Filesystem walk takes >2 minutes: investigate excluded-dir list in `tools/aria-poc/poc.py`. Some new transient dir may need adding to `EXCLUDED_DIRS`.
