# Package 02: hr-rotation-certification-validation

## Metadata
Status: PENDING
Estimated Tokens: 5K
Priority: CRITICAL
Security-Sensitive: no
Parallelizable: yes (Sprint 0, no prerequisites)
Prerequisites: none
Sprint: 0 (hotfix)
Closing-Findings: [HR-CRITICAL-007]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
LIFE-SAFETY: The create-work-rotation handler does not validate that assigned workers hold required certifications (e.g., diving certification for net inspection, chemical handling for treatment operations). In aquaculture, uncertified workers performing hazardous tasks can result in serious injury or death. Regulatory frameworks (IK-Akvakultur, H&S directives) mandate certification checks before task assignment.

## Findings
- **HR-CRITICAL-007**: Rotation creation no certification validation (LIFE-SAFETY)
  - File: `apps/hr-service/src/aquaculture/handlers/create-work-rotation.handler.ts` (~3.9K chars)
  - The handler accepts rotation assignments without checking employee certifications against the rotation's required certification types
  - Root cause: certification validation was deferred during initial implementation and never added

## Affected Files
- `/var/aqua-saas/apps/hr-service/src/aquaculture/handlers/create-work-rotation.handler.ts` (~3.9K chars)
- `/var/aqua-saas/apps/hr-service/src/hr/entities/employee.entity.ts` (~8.2K chars, read certification fields)

## Dependencies
None. This package has zero prerequisites and is Sprint 0 LIFE-SAFETY priority.

## Atomic Commit Plan
```
fix(hr): validate worker certifications before rotation assignment (LIFE-SAFETY)

Add certification validation in create-work-rotation handler: fetch
required certifications for the rotation type, verify each assigned
employee holds valid (non-expired) certifications, reject assignment
with descriptive error if validation fails.

LIFE-SAFETY: Prevents uncertified workers from being assigned to
hazardous aquaculture operations (diving, chemical handling).

Closes: docs/reviews/2026-04-09-critical-fixes#HR-CRITICAL-007
Plan: docs/plans/2026-04-09-critical-fixes/packages/02-hr-rotation-certification-validation.md
```

## Test Plan
- Unit test: employee with valid certification -- rotation created successfully
- Unit test: employee with expired certification -- handler throws ValidationException
- Unit test: employee with no certification record -- handler throws ValidationException
- Unit test: rotation type with no certification requirement -- rotation created (no gate)

## Verification Command
```bash
cd /var/aqua-saas && npx jest --testPathPattern="apps/hr-service/src/aquaculture" --coverage=false
```

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
