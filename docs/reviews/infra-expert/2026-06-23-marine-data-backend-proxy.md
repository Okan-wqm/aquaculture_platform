# FARM-MEDIUM-073: Browser-owned CMEMS/marine tile delivery lacks backend auth, credential protection, and caching

## Finding
Marine (Copernicus / CMEMS) map-tile delivery in `web/modules/farm-module` was performed **client-side**: `services/cmemsService.ts` + `components/map/CMEMSTileLayer.tsx` pointed the browser directly at `https://wmts.marine.copernicus.eu/teroWmts`. That path:
- can only serve the **public, unauthenticated** WMTS datasets — auth-gated Copernicus products are unreachable;
- has **no server-side caching or rate policy**, so every client re-pulls tiles and the platform cannot bound upstream usage;
- couples the browser to an external provider URL with no tenant-scoped gateway contract.

## Root Cause
Protected external-data tile delivery was treated as a browser concern rather than a backend-owned capability. There was no backend marine module or gateway contract to centralize the upstream call, attach credentials, enforce a cache/response policy, or fail closed on an unauthenticated tenant.

## Fix
Backend-owned authenticated proxy (SSoT for marine tile + point delivery):
- `apps/farm-service/src/marine-data/*` — `MarineDataModule` + `MarineDataService` (reuses `SentinelHubService`/`SentinelProxyPolicy` for the authenticated upstream call), `MarineCachePolicy` (private-cacheable tiles, no-store point analysis), `marine-layer-catalog`, contract spec.
- `apps/gateway-api/src/routes/marine.routes.ts` — `MarineRoutesModule` exposing `/api/marine`, **fail-closed when the request has no authenticated tenant user**.
- `web/modules/farm-module` migrated off the browser-direct path onto the typed `marineDataService` client + `MarineAuthenticatedTileLayer` / `useMarineData`; `MapViewPage`, `AOIAnalysisPanel`, `pointQueryService` re-pointed at the backend contract.

## Verification
- `apps/farm-service` marine-data contract spec: 3/3 (cache-control semantics: authenticated tiles private-cacheable, point analysis no-store).
- `apps/gateway-api` marine.routes spec: 2/2 (incl fail-closed on unauthenticated tenant).
- `web/modules/farm-module` `tsc --noEmit`: clean (migration import/type integrity).
