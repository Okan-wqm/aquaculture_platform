# Admin Panel Triangle Audit - 2026-05-20

Scope is limited to:

- `/admin`
- `/admin/analytics`
- `/admin/analytics/reports`

This folder records the frontend, backend, and database alignment work for the platform-admin-only admin panel surface.

Terminology decision: product language calls this actor "platform admin". The current auth-service role enum stores that platform-level actor as `SUPER_ADMIN`, so this PR keeps `SUPER_ADMIN` as the single code-level role and documents it as the platform admin identity.

Implementation branch: `fix/admin-panel-triangle-2026-05-20`
