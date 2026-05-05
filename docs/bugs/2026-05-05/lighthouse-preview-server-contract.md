# 2026-05-05 - Lighthouse Preview Server Contract

## Affected Area
- `.github/workflows/performance-benchmark.yml`
- `web/shell/project.json`
- `web/shell/package.json`

## Observed Issue
Frontend Lighthouse CI built the affected Nx graph successfully, then failed before collecting a valid audit. The workflow executed `npm run preview` at the repository root, but the root package has no `preview` script. Lighthouse then navigated to `http://localhost:4173/` while no preview server was listening and Chrome reported `CHROME_INTERSTITIAL_ERROR`.

## Root Cause
The workflow encoded a root-level preview contract that does not exist. The actual host application preview entrypoint belongs to the `@aquaculture/shell` workspace. The prior fixed `sleep 5` also did not prove that a server was alive before launching Lighthouse.

## Architectural Fix
- Start the shell host through `npm --workspace @aquaculture/shell run preview`.
- Bind the preview server explicitly to `127.0.0.1:4173` so the audited URL and server port match.
- Add an HTTP readiness gate that fails with preview logs if the server exits or never becomes reachable.

## Verification
- GitHub Actions Frontend Lighthouse CI.

## Status
Fixed on 2026-05-05; pending GitHub Actions confirmation.
