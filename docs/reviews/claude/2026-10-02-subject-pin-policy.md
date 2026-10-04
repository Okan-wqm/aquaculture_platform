# Subject-pin policy — committed data, not a kernel literal (2026-10-02)

Context: program plan item K11 (CB-5) and program ruling 15 ("pin paths are policy data in the
kernel, not literals"). ADR-0021 (ARIA-MEDIUM-261) bounds a finding-origin plan's writes by its
admitted surfaces, the project closure of those surfaces and the subject pins of a policy.

Owner: claude (implementation), okan (review). Deadline 2026-10-16.

## ARIA-LOW-280 — The subject-pin policy is a kernel literal any caller can replace

Evidence, on `fix/aria-revision-scope-bound @ 9893b1ba6`:

- `aria-kernel/aria_kernel/plan_origin.py:258` — `SUBJECT_PIN_POLICY: tuple[SubjectPin, ...] = ()`.
  The only way to pin a path into a bound is a literal in kernel source.
- `aria-kernel/aria_kernel/plan_origin.py:297` — `compute_admission_scope(..., pin_policy=...)`. Any
  caller can hand the bound its own pins.
- `aria-kernel/aria_kernel/plan_origin.py:316` — the admission record carries the pins but not the
  policy they came from, and `validate_admission_scope` (`:330`) accepts any pin list.

Rule: a value that widens ARIA's write bound is committed policy data, read at a commit proven on
main, named on the record it shaped, and refused closed when it cannot be read.

### What CB-5 asked for, measured

The program plan expected CB-5 to make the bound admit derived pin paths: a journey pin
(`web/modules/<m>/src/__journeys__/…pin.json`, `apps/<svc>/src/__journeys__/…`) is a new file, so
it is never a grounding ref. Measured on 9893b1ba6 against this repository, for an admission on
`web/modules/hr-module/src/pages/leaves/LeavesPage.tsx` (the CB-6 pilot): closure
`['web-hr-module']`, root `web/modules/hr-module`.

| Path                                                                     | 9893b1ba6 bound |
| ------------------------------------------------------------------------ | --------------- |
| `web/modules/hr-module/src/__journeys__/leaves/leave-type-enum.pin.json` | inside          |
| `web/modules/hr-module/src/pages/leaves/NewHelper.ts`                    | inside          |
| `web/modules/farm-module/src/__journeys__/x.pin.json`                    | outside         |
| `apps/hr-service/src/__journeys__/x.pin.json`                            | outside         |

ADR-0021 decision 2 admits every path under a closure root, so a fix's own journey pin is already
admitted, and so is any other new file of that project. A derivation rule for same-project pins
would add nothing the bound does not hold, so none is added. A pin outside the closure (a backend
fix pinned by a web journey, an event consumer) is what a subject pin is for.

### Fix (same branch)

- `docs/aria/policy/subject-pins.json` (`aria/subject-pins/v1`: `schema_version` 1, `policy_id`
  `aria-subject-pins`, `subject_pins[]` of `{subject, paths}`), shipped empty.
- `plan_origin.load_subject_pin_policy` reads it at the workspace's main-proven commit through
  `main_anchor.resolve_main_anchor` and `main_anchor.committed_blob`, the anchor finding grounding
  admits on. A working-tree edit or an unmerged commit is never the policy.
- `compute_admission_scope` has no pin parameter. It records `pin_policy` (path, commit, blob id,
  refusal) on the admission record (schema version 2).
- A missing, malformed or unanchored policy pins nothing. One bad entry refuses the whole file. The
  reason is named on the record and disclosed once per blob as `subject_pin_policy_refused`.
- `validate_admission_scope` refuses a version-2 record without `pin_policy` and a refused policy
  that still carries pins. A version-1 record (written before this change) folds only with no pins.
- ADR-0021 decision 8 amended.
- Tests: `aria-kernel/tests/test_subject_pin_policy.py`.
