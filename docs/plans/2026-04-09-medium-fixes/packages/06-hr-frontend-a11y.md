# Package 06: hr-frontend-a11y

## Metadata
Status: PENDING
Estimated Tokens: 8K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [HR-MEDIUM-008]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
A single accessibility finding in the HR frontend module: form labels lack `htmlFor` attributes, making the forms inaccessible to screen readers and failing WCAG 2.1 compliance. Isolated into its own package because it touches only the HR frontend module, separate from backend HR fixes.

## Findings

**HR-MEDIUM-008 — Form labels missing htmlFor attribute**
HR module forms (employee creation, leave request, scheduling) use `<label>` elements without `htmlFor` pointing to the corresponding `<input>` id. Screen readers cannot associate labels with inputs.

## Affected Files
- web/modules/hr-module/src/pages/ (form components across employee, leave, scheduling views)
- web/modules/hr-module/src/components/ (shared form components)

## Dependencies
None.

## Atomic Commit Plan
```
fix(hr-module): add htmlFor attributes to all form labels for WCAG 2.1 compliance

Form labels in HR module pages lacked htmlFor attributes, breaking screen reader association.
Added matching id attributes to inputs and htmlFor to labels across employee, leave, and
scheduling forms.

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#HR-MEDIUM-008
Plan: docs/plans/2026-04-09-medium-fixes/packages/06-hr-frontend-a11y.md
```

## Test Plan
- Lint: eslint-plugin-jsx-a11y label-has-associated-control rule passes
- Unit test: render each form, verify every label has htmlFor matching an input id

## Verification Command
`npx tsc --noEmit -p web/modules/hr-module/tsconfig.json && npx vitest run web/modules/hr-module`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
