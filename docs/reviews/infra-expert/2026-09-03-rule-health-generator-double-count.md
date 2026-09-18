# Rule-health report generator prints a doubled override count and executes its own PR body

**Date:** 2026-09-03 · **Agent:** infra-expert · **Cycle:** 2026-09-03 branch-evaluation-merge

## INFRA-MEDIUM-140 — two shell defects in `.github/workflows/rule-health-report.yml`

**Severity:** MEDIUM. **Owner:** infra-expert. **State:** OPEN → closed by the
commit carrying this file.

### What is wrong

1. The override counter is written as
   `$(grep -rE "// auditor-override:" … 2>/dev/null | wc -l || echo 0)` inside a
   `set -euo pipefail` step. On a tree with no override comments `grep` exits 1,
   `pipefail` makes the whole pipeline exit 1 after `wc` has already printed
   `0`, and the fallback prints a second `0`. The unmerged
   `automation/rule-health-2026-08` report shows the result verbatim:
   `**0` on one line and `0**` on the next.
2. The PR body is produced by an unquoted heredoc. Its backticked
   `` `${REPORT_PATH}` `` is therefore a command substitution: the shell tries to
   execute the report path and substitutes the (empty) output, so the opened
   PR never names the file it carries.

### Root-cause fix

- The `grep` runs inside a group that accepts exit status 1 as "no match" and
  lets any other status fail the step; `wc -l` is the only writer of the
  count. Errors are no longer masked by `2>/dev/null || echo 0`.
- The heredoc delimiter is quoted so the body is literal text; the report path
  is inlined by Actions from `steps.generate.outputs.path`, so no shell
  expansion happens in the body at all.

### Evidence

- `.github/workflows/rule-health-report.yml` (Generate report + Open or update
  report PR steps).
- `docs/reviews/rule-health/2026-09-01-rule-health-2026-08.md` on branch
  `automation/rule-health-2026-08` (doubled count).
