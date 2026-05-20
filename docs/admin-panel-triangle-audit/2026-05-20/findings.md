# Findings - 2026-05-20

1. `/admin` contained stale frontend links to `/admin/audit-log`, while the routed admin module exposes `/admin/audit`.
2. `/admin/analytics` linked reports to `/admin/reports`, while the routed page is `/admin/analytics/reports`.
3. Sidebar prefix matching marked `/admin/analytics` active while viewing `/admin/analytics/reports`.
4. Analytics trend APIs mixed `period` and `dataPoints`; `1y` could be interpreted as one yearly point instead of a one-year range.
5. DAU chart intentionally stayed empty even though backend exposes `/analytics/users/activity`.
6. Report generation UI used non-durable local state and unauthenticated `window.open` downloads.
7. Backend report executions cached artifacts in Redis and regenerated on cache miss; Redis is not durable artifact storage.
8. Report CSV output did not fully quote RFC4180 fields and did not guard spreadsheet formula injection.
9. Daily analytics snapshots were not scheduled and duplicate daily rows were possible.
10. Admin API default guard allowed two role names. The auth-service source of truth only issues `SUPER_ADMIN` for the product "platform admin" actor, so this surface must be fixed to that single code-level role.
11. Admin API guard verified JWT signature and roles, but did not enforce `type: access`; a signed refresh/MFA token with copied roles could reach admin-api role checks.
