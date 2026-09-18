# Mobile static assets fail closed — second branch sweep, 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `5cf4757b9`.

Recovered from `feature/aquamobil-v4-redesign`. That branch is a complete, coherent redesign that
main should rebuild through its own recorded 16-slice program rather than merge — porting it would
un-run 95 spec files, drop cleared advisory floors and downgrade react-router. This one fix is
independent of all of that and lands on its own.

## MOB-HIGH-019 — a missing bundle is served as index.html, and cached for a year

**Severity:** HIGH. **Owner:** frontend-expert. **State:** IN-PROGRESS.

**Evidence.** `infrastructure/docker/nginx/aquamobil.conf` guards three things with
`try_files $uri =404` — the service worker, the Firebase messaging worker and the workbox chunks —
and then stops. `location /assets/` (Vite's hashed bundles, `Cache-Control: public, immutable,
max-age=31536000`) and `location /icons/` (30 days) carry no such guard, so a request they cannot
satisfy falls through to `location /`'s SPA fallback, `try_files $uri $uri/ /index.html`.

Two failures compose there. The browser asked for JavaScript and receives an HTML document, so it
parse-errors on `<`. And the asset location's own `add_header` has already applied: the client is
told to keep that HTML, under the bundle's URL, as immutable for a year.

This is the ordinary post-deploy case rather than an exotic one. A PWA client holding a cached
`index.html` asks for a chunk the new build no longer ships; instead of a miss it can recover from,
it gets a poisoned cache entry that survives redeploys and reloads.

**Rule violated.** A location that promises long-lived caching is serving files, not routes. It must
answer a miss with 404 — never with a document the client will store under the asset's URL.

**Fix.** `/assets/` and `/icons/` fail closed with `try_files $uri =404`.
`tests/invariants/mobile-static-asset-fail-closed.spec.ts` derives the rule instead of listing the
locations: it parses the config into brace-balanced location blocks and requires the `=404` guard on
every block whose `Cache-Control` promises more than a day, so a fourth asset location added later
is covered without editing the spec. It also asserts the SPA fallback itself is still there for real
routes.

**Why not the branch's approach.** `feature/aquamobil-v4-redesign` adds a regex location
(`location ~* \.(?:js|mjs|css|woff2?|png|svg|ico|json|map)$`). On main that would take precedence
over the `/assets/` prefix location and drop its immutable caching for exactly the files that need
it most. Making the prefix locations fail closed keeps nginx's matching order intact.

**Closure criterion.** The invariant passes on the fixed config and fails with the exact diagnostic
when the guard is removed (verified both directions); `mobile-csp-headers.spec.ts` stays green, so
the added directives did not disturb the header contract.
