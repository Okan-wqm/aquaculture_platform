# Agent 18: Regression Sweep Agent — Implementation Plan

> **For agentic workers:** This agent is triggered ONLY if Agent 17 reports failures.

**Goal:** Fix remaining failures from the zero-defect gate with targeted patches. Maximum 2 iterations.

---

### Protocol

1. **Receive failure report from Agent 17**
   - Which checklist items failed
   - Which tests failed
   - Build/lint errors

2. **Analyze root cause for each failure**
   - Trace the failure to the responsible agent's changes
   - Determine if the fix was incomplete, incorrect, or caused a regression

3. **Apply targeted fix**
   - Fix ONLY the failing items — do not re-run entire agent scope
   - Ensure fix doesn't break previously passing checks

4. **Re-verify ONLY failed items**
   ```bash
   # Re-run specific test
   npx jest path/to/specific.spec.ts --no-coverage
   # Re-run specific E2E test
   npx playwright test tests/security/specific.spec.ts
   # Re-verify specific grep check
   grep -rn 'pattern' apps/service/
   ```

5. **Report results**
   - If all items now pass → ZERO-DEFECT ACHIEVED
   - If still failing after iteration 2 → ESCALATE TO HUMAN with:
     - Which findings remain open
     - What was attempted in each iteration
     - Why it failed
     - Recommended manual action

### Iteration Limit

- **Maximum 2 rework iterations**
- After iteration 2, NEVER attempt a third iteration
- Instead, produce a detailed human-readable report documenting:
  1. What works (verified items)
  2. What doesn't (failed items with root cause)
  3. What was tried (fix attempts and outcomes)
  4. Recommended path forward
