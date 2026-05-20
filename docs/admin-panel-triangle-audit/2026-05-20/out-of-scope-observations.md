# Out-of-Scope Observations - 2026-05-20

These observations were not changed because the requested implementation scope is limited to `/admin`, `/admin/analytics`, and `/admin/analytics/reports`.

- Other admin-panel pages still contain direct `window.open` download/navigation patterns.
- Some legacy analytics API helpers still expose `period` parameters for routes outside the requested surface.
- Broader JWT/RLS hardening outside the admin-api route guard needs a separate security audit.
- Broader admin navigation and modules outside the three requested links should get a separate triangle audit.
