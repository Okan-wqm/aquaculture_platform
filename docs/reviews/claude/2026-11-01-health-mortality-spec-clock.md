# HealthEventsPage spec depends on the day it runs — 2026-11-01

Found on 2026-11-01 when `main` went red after cead30cf3 (run 41280339757, job `test`,
`farm-module:test`). The merge did not touch farm-module; the project ran because shared-ui
changed.

## FE-MEDIUM-398

Defect. The health page draws daily mortality for the 14 days ending at `new Date()`. Its spec
returns mortality points fixed at 2026-10-18 and 2026-10-19 and expects both counts on the
chart. Once 2026-10-18 was more than 13 days old the page dropped it, and the test failed with
`Unable to find an element with the text: 412`.

Severity MEDIUM: from 2026-11-01 the test fails on `main` and on every pull request that runs
farm-module tests. Owner Okan-wqm, deadline 2026-11-01.

Where.

- `web/modules/farm-module/src/pages/health/HealthEventsPage.tsx:261` counts each day of the
  series back from `new Date()`.
- `web/modules/farm-module/src/pages/health/__tests__/HealthEventsPage.spec.tsx:109` fixes the
  fixture dates; `:151` expects the 2026-10-18 count.

Fix. The spec pins `Date` to 2026-10-19 12:00 UTC (only `Date` is faked, so `userEvent` and
`waitFor` keep real timers), the way `TasksPage.spec.tsx` already does. The result no longer
depends on the day the suite runs.

Verified. With the clock pinned the spec passes; with the pin removed it fails on the same
assertion as on `main`.
