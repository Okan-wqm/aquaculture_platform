# Tenant Console D6 — Industry shell on the tenant console (2026-10-16)

Source: the Claude Design handoff `design_handoff_tenant_console_industrial` (main reference
`Tenant Console D6 Repo.dc.html`, page map `tenant-repo.js`). The design re-skins and restructures
the tenant console; what the repo already has stays the basis. Every item the designer marked NEW
was checked by two independent searches of `web/` and `apps/` before it was built; items that
already exist elsewhere are linked from the navigation instead of rebuilt (parameter dictionary →
`/sites/water-chemistry?tab=parameters`, reading sources → `?tab=sources`, slaughter facilities →
`/sites/setup/slaughter-facilities`, device status → `edgeDeviceStats`).

Owner: claude (implementation), okan (review).

Okan's decisions (2026-10-16): absent backends get a labelled preview, rendered only through a typed
`MockPreview` path, each with a tracked finding below; `/sensor/commands` shows the real fragments
and previews the rest; per-module alarm counts in the workspace menu are a labelled preview.

## Work findings

### FE-HIGH-333

The tenant console painted the Suderra paper/teal palette with rounded cards and a serif display
face, and the token scope (`:where(.sd-page, .sd-surface)`) reached only pages that carry
`sd-page`: no farm, sensor, hydroponics or dashboard page does, nor any portaled dialog. Phase 1
re-points the `sd-*` tokens to the Industry palette (Drawing light / Control room dark), adds the
hazard, grid and workspace-accent tokens, loads Barlow / Barlow Condensed, squares the scope's
radii, draws blueprint corner marks on `.sd-card`, replaces the paper glow with the engineering
grid and noise, and widens the scope to the console column and to dialogs opened over it.

### FE-HIGH-334

The tenant shell had no workspace (module) switcher, console header, title block, command palette
or annunciator; the header search submitted to an empty handler. Phase 2 builds them.

### FE-HIGH-335

The route inventory (186 route declarations, 101 leaf pages) found 22 pages reachable by URL only
and two module-user links (`/analytics`, `/reports`) that resolve to NotFound outside the layout.
The console navigation covers every leaf page, and a nav-coverage invariant fails the build on an
unreachable route.

### FE-MEDIUM-336

HR Today, the facility structure tree and the two architecture documents had backing data (or are
static) but no UI.

### HR-HIGH-022

`LeaveRequest.startDate/endDate` and `AttendanceRecord.date` hydrated as `YYYY-MM-DD` strings that
the GraphQL `DateTime` scalar refuses, so `teamLeaveCalendar`, `leaveRequests`,
`attendanceRecords` and `todaysAttendance` failed once a row existed. Fixed with the shared
`DateColumnTransformer`; three of the 45 columns of FARM-MEDIUM-424, which stays open for the rest.

### FARM-MEDIUM-438

`DepartmentResponse.departmentManager` mapped to no column; the stored `managerUserId` /
`managerName` had no response field. The response now exposes the two columns.

### FE-MEDIUM-337

No sanctioned way existed to show preview data for a feature whose backend does not exist. The
typed preview path makes rendering preview data without its notice impossible.

## Tracked backend gaps (rendered as labelled previews)

| ID                | Gap                                                | Preview surface                             |
| ----------------- | -------------------------------------------------- | ------------------------------------------- |
| FARM-MEDIUM-439   | No budget per cost centre                          | Finance › Budget                            |
| FARM-MEDIUM-440   | No cost centres or allocation keys                 | Finance › Cost centres, facility cost share |
| SENSOR-MEDIUM-185 | No unified command log or lock model               | `/sensor/commands` unified log and locks    |
| ALERT-MEDIUM-010  | No server-side alarm summary by priority or module | workspace-menu module counts                |
| FE-LOW-338        | No page/sheet revision concept                     | title-block revision cell                   |

Owner okan, deadline 2026-11-16 for each.
