# Marine Data Explorer — End-to-End Audit + Final Architecture & Migration Plan

**Status:** planning document (no product code). Design-of-record for building a Copernicus-Marine-Viewer-like "Marine Data Explorer" on the existing `/api/marine` + Leaflet + Sentinel/CMEMS stack. Execution is phased (§6); each phase is a separate PR that references the finding IDs it closes.

## Context

Build a Copernicus-Marine-Viewer-like "Marine Data Explorer" on the existing `/api/marine` + Leaflet + Sentinel/CMEMS stack. We do not re-host Copernicus; we pull layers from CMEMS (public WMTS) and Sentinel Hub/CDSE (per-tenant OAuth Process API) behind one provider-neutral façade. The hard problem is one honest contract over datasets with different date/depth/resolution/scientific semantics.

This plan is grounded in an end-to-end review: 3 exploration agents + an 8-dimension adversarial review (backend-core, sentinel-security, frontend-map-truth, contract-parity, resilience-caching, scientific-validity, tests-coverage, tenant-isolation) + a coverage critic. The 8 finders produced **79 findings**; each was adversarially verified by 2 independent lenses (evidence + validity): **135 verdicts, 130 confirmed / 5 refuted**. Status per finding (§7): **CONFIRMED-2L** = both lenses confirmed; **REFUTED-2L** = a lens refuted the claim (the 4 corrected below); **CONFIRMED-RR** = re-read and confirmed where no isolated 2-lens verdict exists.

**The 5 refutations corrected 4 findings** (adversarial verification caught what a single read missed): (1) **DO scale floor** — the `minValue:150` catalog value is consumed by no rendered legend; the live DO legend (`getCMEMSLegend`, `cmemsService.ts:141`) explicitly shows `<100` and `100–150` hypoxia bins, so no hypoxia is hidden *today* (it becomes a catalog-v2 migration trap instead — §4.6); (2) **availability stub** — `available:true`/`fallbackApplied` mislead nobody because `fetchMarineAvailability` has zero callers → TECH-DEBT, not UX-MISLEADING; (3) **CMEMS date clamp** — intended contract-encoded policy, unreachable 400, no forecast feature → design consideration, not a defect; (4) **WMS confused-deputy** — instanceId is documented non-secret and CDSE authorizes by the tenant's own token → not a vulnerability (the confirmed finding on that controller is F20, the `public` cache header).

Topology is sound (no BLOCKER/CRITICAL security): browser never sees provider URLs/credentials, tiles flow as authenticated blobs, evalscripts server-owned, CDSE creds AES-256-GCM encrypted per tenant, per-tenant tables correctly omit `schema:`. The review found the Sentinel surface is **more broken than first thought** — point queries 400 unconditionally AND tiles 400 at the activation zoom — plus aquaculture-relevant scientific-validity defects.

## Three structural gaps

1. **No provider abstraction** — `apps/farm-service/src/marine-data/marine-data.service.ts` (652 lines) branches on `layer.source`.
2. **No honest contract** — catalog lacks cadence/latency/depth/resolution/provenance; UI silently substitutes dates, advertises 6 unrenderable layers, renders 25 km model grids as smooth imagery, hard-codes legends that contradict the catalog.
3. **No resilience** — no breaker/retry/server cache/per-tenant rate limits (violates repo circuit-breaker invariant); several external calls have no timeout and forward upstream status verbatim.

## Decisions

| # | Decision | Resolution |
|---|---|---|
| D1 | Sequencing given Sentinel is broadly non-functional (point-query + low-zoom tile both 400) | **Default: fix Sentinel in P0** so both providers work at the Explorer launch (F1/F2/F3 are P0). Alternative if a faster first release is preferred: ship CMEMS-only and move Sentinel repair behind a capability flag to a later phase. |
| D2 | Phantom Sentinel layers (CYANOBACTERIA, CDOM, TSS, SECCHI, NDVI, MOISTURE) | Remove now (P0); re-add only with validated evalscripts + caveats. NDVI/MOISTURE are land products. |
| D3 | CMEMS usage accounting durability | Redis daily counters (TTL 40d), not a new table. |
| D4 | Raw `api/sentinel-hub/{process,wms}` routes (no frontend consumers) | Deprecate P2, delete P4; STAC catalog-search becomes internal (`SentinelHubService.searchAcquisitions`). |
| D5 | Open-Meteo marine (weather module) | Stays out of the façade; the port allows an `open-meteo-marine` point-only adapter later without contract change. (Its current bugs F-WX-01/F-WXDTO/F-WXTEST are fixed regardless — §7b.) |
| D6 | Legacy proxy `Cache-Control: public` cross-tenant leak (§7 F20) | **Default: P0 hotfix** (→ `private`), then delete the routes in P4. Alternative: rely solely on the P4 route deletion (unused, auth-gated) and accept the longer exposure window. |
| D7 | MapViewPage marine overlays | Removed in P4; MapViewPage → site-ops + "Open in Marine Explorer" deep link (kills dual-date-state at root). |

## 1. Provider-neutral façade (backend)

New `apps/farm-service/src/marine-data/providers/` (inside the module; read-only proxy domain — controller → service → provider port, no CQRS bus, consistent with the FARM-MEDIUM-073-reviewed shape).

- **Port** `providers/marine-provider.port.ts`: `MarineDataProvider` with `providerId`, `capabilities` (`tiles`, `pointQuery`, `aoiAnalysis`, `availabilityMode: 'intervals' | 'dates'`, `depthAxis`), methods `getTile/getPoint/getAoi/getAvailability`. Every result carries `MarineResolution` = `{ requestedDate, effectiveDate, dateSubstituted, requestedDepth, effectiveDepth, cacheHit }` — forwarded verbatim; nothing downstream synthesizes one.
- **Registry** `providers/marine-provider.registry.ts`: injectable; catalog entries gain `providerId` + discriminated-union `providerRef`. Registry asserts at module init every catalog entry resolves to a registered provider — orphan layer fails boot (tier-1 "make it impossible").
- **Adapters** `providers/cmems-wmts.provider.ts` (absorbs `fetchCmems`, `buildWmtsParams`, GetFeatureInfo extraction; availability from WMTS GetCapabilities `Dimension` TIME/ELEVATION) and `providers/sentinel-process.provider.ts` (absorbs `getSentinelTile/getSentinelPoint/fetchSentinelProcess`; availability via CDSE STAC under tenant creds).
- **Shared upstream client** `providers/marine-upstream.client.ts`: single place for timeout, bounded retry, and `CircuitBreakerService.execute` wrapping — adapters cannot bypass the breaker by construction.
- Pure parsing (`parseDepth`, tile math, date validation, projection edge cases) moves to `marine-request.parser.ts`; `MarineDataService` shrinks to parse → catalog → registry → capability check → rate-limit → delegate → map resolution (~150 lines, zero `source ===` branches).
- **Duplicate Sentinel body-builder consolidation** (P0): extract `apps/farm-service/src/sentinel-hub/sentinel-process-request.factory.ts` (`buildSentinelProcessBody(policy, evalscriptOverride?)`); both `MarineDataService.fetchSentinelProcess` and `SentinelHubProxyController.proxyProcessingApi:146-179` delegate; spec asserts byte-identical bodies.

## 2. The honest contract (`/api/marine` v2)

- **Catalog** `GET /api/marine/layers` → versioned envelope `{ contractVersion: 2, layers: MarineLayerDto[] }`. Each layer: `id` (canonical), `providerId`, `category`, `variable` (CF standardName, **units**, renderRange, linear/log scale), `temporal` (`kind: 'model-daily'|'satellite-acquisition'`, cadence, latencyDays, defaultLookbackDays), `depth` (`{kind:'none'}` | `{kind:'levels', levels, units:'m', positiveDown:true}`), `spatial` (`nativeResolution` + `coverage: 'global'|bbox`), `provenance` (provider, productId/datasetId, doi, **attribution** — Copernicus license requires on-screen — license), `capabilities`, `legend` ({type, stops[]} — single legend source, **must be bound to the actual render STYLE/range**), `scientific` ({meaning, caveats[]}). Static in `marine-layer-catalog.ts` except depth levels + temporal bounds, which availability verifies live (metadata fail-open, data never). **Dataset version resolution:** stop hard-pinning `_YYYYMM` dataset suffixes (F23) — resolve current version via WMTS GetCapabilities, keep the pin only as fallback, fail loudly (not silent no-data) on retirement.
- **Availability** `GET /api/marine/layers/:layerId/availability?from&to&bbox` — replaces the unconditional `available:true` stub (F7). Model → coverage `intervals`; satellite → viewport-scoped discrete `dates` (bbox required in `dates` mode). Includes `latestAvailable`, `depthLevels`. Redis-cached: CMEMS GetCapabilities 6h shared; Sentinel STAC 1h per tenant, bbox quantized 0.5°.
- **No-silent-substitution rule**: binary responses carry `X-Marine-Requested-Date`, `X-Marine-Effective-Date`, `X-Marine-Date-Substituted`, `X-Marine-Effective-Depth`, `X-Marine-Cache: hit|miss|stale`; JSON embeds `resolution`. Default `dateResolution=exact`: dated request with no data → **404 + headers**, never a neighbor. `nearest` is explicit opt-in and still flags substitution. Omitted date = "latest", reported via `effectiveDate`. Depth snaps server-side; depth on `kind:'none'` → 400. Gateway `apps/gateway-api/src/routes/marine.routes.ts` must pass `X-Marine-*` through — gateway spec guards it.
- **Error contract**: upstream failures MUST NOT map to HTTP 200 with a null/empty body (F15/F16). Define explicit no-data (`{value:null, quality:'no_data', resolution}`) vs error (5xx/503) shapes. Do not forward raw upstream 401/403/429 verbatim (F19).
- **Input validation**: replace the plain-interface `MarinePointQueryBody`/`MarineAoiAnalysisBody` (controller:23-39) with class-validator DTOs so the global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` actually runs (F9).

## 3. Resilience & efficiency

- **Breakers** (reuse `libs/backend-common` `CircuitBreakerService`; precedent `mattilsynet-api.service.ts`), inside `marine-upstream.client.ts`: `cmems-wmts` global-keyed, `sentinel-process`/`cdse-token` per-tenant. `CircuitOpenError` → 503 + Retry-After; tiles may serve stale cache (marked `X-Marine-Cache: stale`).
- **Timeouts everywhere**: the CDSE OAuth token fetch currently has **no timeout** — a hung request wedges all Sentinel traffic for the tenant via the shared in-flight promise (F13). Add timeout + negative-cache failed token fetches (F17).
- **Retry**: 1 retry w/ jitter for idempotent CMEMS GETs on network/5xx only. No retry on Sentinel Process (burns PUs). Fix Open-Meteo retrying non-retryable 4xx (F18). Retries recorded as breaker samples.
- **Tile cache**: `marine-tile-cache.service.ts` on existing `RedisService` (+ additive `getBuffer/setBuffer`). CMEMS **shared, tenant-free** key `marine:tile:cmems:...` — documented exception (public unauthenticated upstream, no tenant-derived input), guarded by `marine-tile-cache.tenancy.spec.ts` (CMEMS keys have no tenantId AND Sentinel keys always do). Sentinel **per-tenant** key `marine:tile:sentinel:{tenantId}:...` (produced under tenant PU quota). TTLs: CMEMS past 24h / latest 1h; Sentinel 24h; only 2xx `image/*` cached.
- **Per-tenant rate limiting** `marine-rate-limit.policy.ts`: Redis fixed-window; defaults tiles 600/min, point 60/min, aoi 10/min, availability 60/min → 429 + Retry-After. Closes the 2026-04-08 rubric HIGH (quota DoS).
- **Usage parity**: Redis daily counters incremented on actual upstream calls only. Fix that Sentinel `usageCount` counts token *mints*, not API calls (F21); CMEMS has zero accounting.
- **Client-disconnect propagation**: propagate `AbortController` from client through gateway/farm-service so aborted tile requests don't complete upstream fetches (wasted PUs).

## 4. Root-cause defect fixes

1. **Sentinel point-query break (F1)**: point requests **64×64** with bbox widened to ±0.0032° (~64 native 10 m px) + center-pixel sampling in `decodeSentinelPoint`. Keeps ONE process-request policy (a second "point class" recreates the drift). Cost-neutral. New spec `marine-data/__tests__/marine-point-query.spec.ts`.
2. **Sentinel low-zoom tile break (F2)**: `MAX_SENTINEL_TILE_MATRIX=18` admits z=0..18, but `tileToBbox4326(z≤8)` exceeds `MAX_BBOX_DEGREES_AREA=1` (z=8 equatorial ≈1.98°²) → policy 400. With `SENTINEL_MIN_ZOOM=8` (frontend), every Sentinel tile 400s at the activation zoom below ~60° latitude — i.e. all Turkish coastal deployments. Fix: derive the minimum servable tile matrix and the policy bbox cap from **one shared SSoT constant** so `parseTileMatrix` structurally admits only zooms whose worst-case tile satisfies the policy (tier-1). Raise `SENTINEL_MIN_ZOOM` to match. New spec asserts tile math vs policy.
3. **sharp-fed upstream error → 500 (F3)**: `getSentinelPoint` pipes the upstream error *body* into `sharp`, turning upstream 4xx/5xx into unhandled 500s. Check `response.ok` before decode; map to the explicit error contract (§2).
4. **Hardcoded `datasetId:'sentinel-2-l2a'` (F10)**: flows from `providerRef.collection`, not a call-site literal.
5. **Depth sign (F5)**: depth is sent as a positive ELEVATION but the CMEMS ocean elevation dimension is negative-down — requested depths select the wrong/no level. Fix in the CMEMS adapter: map catalog depth (positive-down metres) to the dataset's actual signed ELEVATION values from GetCapabilities.
6. **DO scale — catalog-v2 migration trap (F6, REFUTED-2L as current bug)**: NOT a current defect — the live DO legend uses the dedicated `getCMEMSLegend` (`cmemsService.ts:141`) which already renders `<100` / `100–150 mmol/m³` hypoxia bins; the catalog `minValue:150` (`marine-layer-catalog.ts:95`) is consumed by no rendered legend. BUT catalog v2 deletes the legacy hardcoded legend tables and derives legends from catalog `legend.stops` (§2, §4.10) — so unless the DO catalog entry carries a hypoxia-covering `renderRange` (0–350) + hypoxia class stops, the migration would *regress* the hypoxia visibility the legacy bins currently provide. Requirement on catalog v2, not a P0 hotfix.
7. **Turbidity inversion (F-TURB)**: turbidity point retrieval inverts at high reflectance (most turbid water → 0 NTU). Fix the decode/evalscript so monotonic.
8. **STYLE omission (F-STYLE)**: CMEMS WMTS requests omit `STYLE`, decoupling rendered colors from the catalog's advertised min/max. Bind the request STYLE to the catalog `legend`/`renderRange`.
9. **Mediterranean gate**: delete `isInMediterranean`; spatial gating is exclusively catalog `spatial.coverage` (CMEMS products `'global'`); violation = server 400.
10. **Legacy/canonical ID unification**: delete `services/sentinelHubService.ts`, `services/cmemsService.ts`, `LEGACY_*_TO_MARINE`, all 3 legend tables + synthesized 3-stop legend; legends from catalog `legend.stops`; `toMarineLayerId` deleted P4.
11. **CHLOROPHYLL ambiguity**: canonical distinct layers (`sentinel:chlorophyll` optical estimate w/ caveat "uncalibrated normalized-difference index, not quantitative mg/m³" vs `cmems:chlorophyll` model) with own caveats; inspector shows both labeled — no arbitrary preference.
12. **Availability wiring / silent substitution / stranded+wrong depth**: one root cause (contract had no honest metadata) — fixed structurally by §2 + §5.

## 5. Frontend Marine Data Explorer

- **New route** `/sites/marine` → `pages/marine/MarineExplorerPage.tsx` (one-line lazy Route in `Module.tsx`; no shell change). Strangler over MapViewPage; P4 strips its marine overlays (D7).
- **State**: single `useReducer` + context, URL-synced (`layerId`, `date | 'latest'`, `depth`, viewport, inspector, aoi, `resolved`). Server state exclusively TanStack Query with `createTenantQueryKey`. `MarineAuthenticatedTileLayer` kept as transport but per-tile fetch goes through `queryClient.fetchQuery` (tenant-scoped key) and reads `X-Marine-*` headers → dispatches `resolved`. **Fix the object-URL leak** (add `revokeObjectURL` + abort in-flight tile fetches on prune) and the **stale point-query race** (aborted-check reads the replacement controller; signal never reaches the network call).
- **Catalog-driven components** (`components/marine/`): `LayerCatalogPicker` (renders only catalog layers — phantom layers impossible; provenance badge + caveat tooltip), `TimelineBar` (intervals band vs acquisition dots; gaps non-selectable), `DepthSelector` (iff `depth.kind==='levels'`; shows effectiveDepth), `ResolvedDateBanner` (on `dateSubstituted`/`requestedDate===null`), `NativeResolutionHint` (+ "show native grid" toggle, `image-rendering:pixelated`; remove the multiply-blend "land mask" that tints all data colors), `LegendPanel` (catalog stops + units + **attribution on-screen**), `PointInspector` (value + quality + resolution; side-by-side chlorophyll), `AoiPanel` (stats implemented server-side P5 or deleted). All built i18n-correct (`useI18n`) and a11y-correct from the start.
- **Timezone**: unify date handling — contract dates are UTC calendar days end-to-end (fixes F-TZ local-tz vs UTC daily breakage window).
- **Deletions (P4)**: legacy services, `useSentinelTiles`, `CMEMSTileLayer`, `SentinelTileLayer`, `SatelliteLayerControl`, `WaterQualityLegend`, `DateRangePicker`, `buildMarineTileUrl`, `useMultiPointQuery`, `MultiLayerLegend`, `GradientLegend`, superseded warnings; shared `utils/colorScale.ts` replaces the 3 hardcoded tables.

## 6. Migration phasing (each independently shippable; gates = named specs green)

- **P0 — defect fixes on existing surface** (~15 files): point-query 64×64 fix + spec (F1); low-zoom tile SSoT fix + spec (F2); check `response.ok` before sharp (F3); datasetId from registry (F10); class-validator DTOs for marine + weather-settings inputs (F9, F-WXDTO); `currentWeather` zero-safe mapping (F-WX-01) + weather read-path spec (F-WXTEST); `sentinel-process-request.factory.ts` extraction + spec (F-DUP); remove phantom layers (F-PHANTOM); delete `isInMediterranean`; add `sentinel_hub_settings` MOVED_TABLES assertion (F-SCHEMA); redact docs instance ID (F-DOCLEAK); **[if D6=hotfix]** flip legacy proxy `Cache-Control` to `private` (F20). (DO-scale F6 and availability-wiring move to P2 — verification showed neither is a current-state bug.) Gate: existing `marine-data.contract.spec.ts` + `sentinel-proxy.policy.spec.ts` green + new specs.
- **P1 — provider port + adapters + resilience** (~14 files): port, registry, both adapters, `marine-upstream.client.ts` (breaker + retry + token-fetch timeout + negative cache), `marine-request.parser.ts`; 4 new London-style specs (model `mattilsynet-api-breaker.spec.ts`). Gate: contract spec byte-identical = refactor proof.
- **P2 — honest contract v2 + caching + rate limiting** (~16 files): catalog v2 (correct units/ranges/depth-sign/STYLE binding/version resolution), availability v2, `X-Marine-*` headers + exact-date policy, explicit error contract, depth snapping, tile cache + `RedisService.getBuffer/setBuffer`, rate-limit policy, usage counters, gateway header passthrough + spec, frontend v2 parser + timezone unification, sentinel-hub route deprecation logging. Deploy order: farm-service → gateway → web, one release train. New specs: availability, resolution-headers, tile-cache tenancy, rate-limit.
- **P3 — Explorer page** (~14 new frontend files): page, reducer, hooks, 8 components + tests; fix object-URL leak + point-query race; i18n + a11y correct. Gate: timeline gaps, substitution banner, depth-on-CMEMS-only, catalog legend, tenant-scoped keys asserted.
- **P4 — strangler cleanup** (~16 files deleted/trimmed): MapViewPage marine strip + deep link; legacy deletions; `api/sentinel-hub/{process,wms}` route deletion (closes F20 permanently); legacy string externalization (F-I18N). Gate: grep-clean for legacy IDs; bundle builds; invariant suites green.
- **P5 — optional**: compare slider, AOI server stats, usage endpoint, Open-Meteo adapter revisit, Sentinel tile-vs-point chlorophyll algorithm unification, forecast-date display (revisits F-FORECAST).

## 7. Audit findings

Finding IDs below are plan-local (`F*`). When a phase is scheduled, promote its findings into `docs/reviews/_registry/findings.jsonl` with registry-conformant `{SEVERITY}-{sequential}` IDs, and reference those in the fixing commits' `Closes:` lines.

| ID | Severity | Status | Finding | Evidence | Phase |
|---|---|---|---|---|---|
| F1 | HIGH | CONFIRMED-2L | Every Sentinel point-query 400s (width/height='1' vs MIN_DIMENSION=64) | `marine-data.service.ts:239-243`, `sentinel-proxy.policy.ts:10,224-230` | P0 |
| F2 | HIGH | CONFIRMED-2L | Sentinel tiles at z≤8 rejected by bbox-area policy; with `SENTINEL_MIN_ZOOM=8` every activation-zoom tile 400s <~60°N (all Turkish coasts) | `marine-data.service.ts:24,204,209`, `sentinel-proxy.policy.ts:8,190-192`, `MapViewPage.tsx:275` | P0 |
| F3 | HIGH | CONFIRMED-2L | `getSentinelPoint` feeds upstream error text into `sharp` → unhandled 500 | `marine-data.service.ts` decode path | P0 |
| F6 | SCIENTIFIC-VALIDITY (migration) | REFUTED-2L as current bug | DO `minValue:150` is unused by any live legend (live DO legend shows hypoxia bins). Catalog-v2 legend migration must carry hypoxia-covering renderRange or it regresses | `marine-layer-catalog.ts:95` vs `cmemsService.ts:141` | P2 |
| F9 | MEDIUM·SECURITY | CONFIRMED-RR | POST bodies are plain TS interfaces → global ValidationPipe never validates point-query/aoi | `marine-data.controller.ts:23-39,97-142` | P0 |
| F5 | MEDIUM·SCIENTIFIC-VALIDITY | CONFIRMED-2L | Depth sent as positive ELEVATION vs CMEMS negative-down → wrong/no model level | `marine-data.service.ts:472-478` | P2 |
| F-TURB | MEDIUM·SCIENTIFIC-VALIDITY | CONFIRMED-2L | Turbidity point retrieval inverts at high reflectance (most turbid → 0 NTU) | `sentinel-product-registry.ts` point evalscript | P2 |
| F-STYLE | MEDIUM·UX-MISLEADING | CONFIRMED-RR | CMEMS WMTS omits STYLE → tile colors decoupled from advertised min/max | `marine-data.service.ts` WMTS build, catalog ranges | P2 |
| F-CHL | MEDIUM·SCIENTIFIC-VALIDITY | CONFIRMED-2L | Sentinel chlorophyll/turbidity tiles are uncalibrated red/green index under a quantitative mg/m³ · NTU legend | `sentinel-product-registry.ts` (tile vs point evalscript) | P2 caveats; P5 |
| F7/F16 | TECH-DEBT | REFUTED-2L as UX; facts confirmed | Availability endpoint returns `available:true` unconditionally + `fallbackApplied` unreachable, but `fetchMarineAvailability` has ZERO callers → stub to implement for Explorer, not actively misleading | `marine-data.service.ts:88-111`, `marineDataService.ts:398-425` | P2 |
| F-DATE | HIGH·UX-MISLEADING | CONFIRMED-2L | CMEMS silently substitutes requested date; `DataAvailabilityWarning` never rendered; FE local-tz "latest" can be a date backend 400s → blank layer | `CMEMSTileLayer.tsx:100`, `cmemsService.ts:228`, `MapViewPage.tsx:513` | P2 |
| F13 | HIGH | CONFIRMED-2L | CDSE OAuth token fetch has no timeout → hung request wedges all tenant Sentinel via shared in-flight promise | `sentinel-hub.service.ts` token path | P1 |
| F-BREAK | HIGH | CONFIRMED-2L | No circuit breaker on CMEMS/CDSE/Sentinel calls despite repo rule + existing `CircuitBreakerService` | `marine-data.service.ts:389-415` | P1 |
| F-RL | HIGH·SECURITY | CONFIRMED-2L | No per-tenant rate limiting on marine routes (PU/quota DoS) | controller (absent) | P2 |
| F17 | MEDIUM | CONFIRMED-2L | Failed token fetches not negative-cached → every request re-runs decrypt + DB write + OAuth POST | token path | P1 |
| F15 | MEDIUM | CONFIRMED-2L | CMEMS point-query maps upstream failure to HTTP 200 + null body (unparseable) | `marine-data.service.ts` CMEMS point | P2 |
| F19 | MEDIUM | CONFIRMED-2L | Upstream 401/403/429 relayed verbatim; no token-cache invalidation on CDSE 401 | proxy + service | P1/P2 |
| F18 | LOW | CONFIRMED-2L | Open-Meteo retry loop retries non-retryable 4xx; retries exist only for Open-Meteo | `open-meteo.service.ts:207` | P1 |
| F20 | TENANT-ISOLATION | CONFIRMED-2L | Legacy proxy sets `Cache-Control: public, max-age=3600` on tenant-OAuth imagery → shared/CDN cross-tenant leak (distinct from the refuted confused-deputy claim on the same controller) | `sentinel-hub-proxy.controller.ts:102,201,266` | P0(hotfix)/P4 |
| F-CREDW | TENANT-ISOLATION | CONFIRMED-2L | Credential writes (save/delete/updateInstanceId) bypass the fail-closed tenant boundary reads use | `sentinel-hub.service.ts` write path | P1 |
| F-TOKINV | MEDIUM | CONFIRMED-2L | `deleteSettings` doesn't invalidate cached CDSE token; in-flight refresh races invalidation → revoked creds keep authorizing | `sentinel-hub.service.ts` cache | P1 |
| F-TENID | LOW | CONFIRMED-RR | `extractTenantId` falls back to header-derived `req.tenantId`, copy-pasted across two controllers | `marine-data.controller.ts:154-160`, `sentinel-hub-proxy.controller.ts:45-53` | P2 |
| F10 | MEDIUM | CONFIRMED-RR | Hardcoded `datasetId:'sentinel-2-l2a'` in point response | `marine-data.service.ts:252` | P0 |
| F-DUP | MEDIUM·TECH-DEBT | CONFIRMED-RR | Duplicated Sentinel process request body in service + proxy controller | `marine-data.service.ts:282-313`, `sentinel-hub-proxy.controller.ts:146-179` | P0 |
| F-PHANTOM | UX-MISLEADING | CONFIRMED-RR | 6 advertised Sentinel layers map to null → error toast on select | `marineDataService.ts:110-121` | P0/P4 |
| F-DEPTHUI | MEDIUM | CONFIRMED-RR | Stranded depth: backend+contract support depth, no UI, never passed | `marine-data.service.ts:472-478`, no DepthSelector | P2+P3 |
| F-RES | SCIENTIFIC-VALIDITY·UX | CONFIRMED-2L | 25 km/9 km model grids rendered as smooth tiles + "land mask" tint = false precision; no resolution disclosure | `CMEMSTileLayer.tsx:151,164` | P2+P3 |
| F23 | MEDIUM·TECH-DEBT | CONFIRMED-RR | CMEMS dataset IDs hard-pinned to `_YYYYMM` version suffixes → silent no-data on Copernicus version retirement | `marine-layer-catalog.ts:93,103,113,123,133,143,153` | P2 |
| F-FORECAST | design consideration | REFUTED-2L as defect | today−2 clamp is intended contract-encoded policy (`cmems-latest-minus-two-days`); 400 path unreachable, no forecast feature exists. Revisit only if the Explorer wants forecast display | `marine-layer-catalog.ts:92,181` datePolicy | P5 |
| F-CACHE | MEDIUM | CONFIRMED-2L | No server-side tile/response cache — every pan re-hits upstream (latency + PU spend) | module-wide | P2 |
| F-LEAK | LOW·TECH-DEBT | CONFIRMED-2L | Frontend leaks object URL per pruned tile; no abort of in-flight tile fetches | `MarineAuthenticatedTileLayer.tsx:75` | P3 |
| F-RACE | LOW | REPORTED | Stale point-query race: aborted-check reads replacement controller; signal never reaches network | `useMapPointQuery.ts:177` | P3 |
| F-TZ | MEDIUM·UX-MISLEADING | REPORTED | Date contract local-tz on FE, UTC on BE → daily breakage window east of UTC | FE date builders vs backend | P2 |
| F-QK | TECH-DEBT | CONFIRMED-RR | Marine fetches outside `useMarineData` bypass TanStack Query + `createTenantQueryKey` | `useSentinelTiles.ts`, `useMapPointQuery.ts`; FARM-MEDIUM-091 family | P3 |
| F-DEAD | TECH-DEBT | REPORTED | Dead code: `buildMarineTileUrl`, `useMultiPointQuery`, `MultiLayerLegend`, `GradientLegend`, AOI stats declared-never-computed | various | P4 |
| F-DATESTATE | TECH-DEBT | CONFIRMED-RR | Two competing date states synced by effect (MapViewPage `selectedDate` + `useSentinelTiles`) | `MapViewPage.tsx` | P4 (deleted, not synced) |
| F-TESTS | HIGH·TECH-DEBT | CONFIRMED-RR | ~5,000 LOC marine FE + all core service pipelines have zero specs; only spec asserts catalog shape + cache headers; no integration/e2e marine test | `marine-data.contract.spec.ts`, `marine.routes.spec.ts` (2/5 routes) | every phase adds specs |

**Verification note:** rows tagged `CONFIRMED-2L` had both adversarial lenses confirm; `CONFIRMED-RR` were re-read this session where no isolated 2-lens verdict exists. Still **REPORTED** (single-finder — re-confirm before the fixing commit): **F-RACE**, **F-TZ**, **F-DEAD**. Refuted/reclassified by the adversarial gate: **F6, F7/F16, F-FORECAST, confused-deputy** (see Context).

_Tenant isolation: no violation on the active `/api/marine` path (tile transport, token cache, `useMarineData` keys correctly scoped). Risks: the legacy proxy `public` cache header (F20) and the by-design shared CMEMS tile cache (locked by a dedicated tenancy spec, §3)._

### 7b. Coverage-critic supplemental findings (file:line-verified — surfaces the 8 dimensions missed)

| ID | Severity | Finding | Evidence | Phase |
|---|---|---|---|---|
| F-WX-01 | HIGH·SCIENTIFIC-VALIDITY | `currentWeather` truthy-guards drop **exact-zero** measurements → `undefined` (calm sea 0 m, 0 °C, N = 0°, 0 mm precip, 0 % cloud); `DecimalTransformer.from` returns a number so `0` is falsy. Single most impactful new correctness bug in the review | `weather.resolver.ts:113-125`, `decimal-transformer.ts:32-40` | P0 |
| F-WXDTO | MEDIUM·SECURITY | Weather-settings mutation DTO has no `@Min`/`@Max` on `forecastDays`/`syncIntervalMinutes` → `0`/negative interval makes the cron re-sync every tick (same class as F9) | `weather/dto/weather-settings.input.ts` | P0 |
| F-SCHEMA | MEDIUM·TENANT-ISOLATION | `sentinel_hub_settings` (holds AES-GCM-encrypted Copernicus creds) is missing from the `MOVED_TABLES` per-table location assertion its three siblings get — asymmetric guard on the most sensitive table | `schema-invariants.spec.ts:232-246`, `schema-manager.service.ts:492` | P0 (add assertion) |
| F-I18N | MEDIUM·UX-MISLEADING | Entire marine/map UI hardcodes Turkish, bypassing platform i18n (violates governance rule FE-HIGH-020); EN-locale users get an untranslated surface | `SatelliteLayerControl.tsx`, `WaterQualityLegend.tsx`, `DateRangePicker.tsx`, `AOIAnalysisPanel.tsx` | P3 (Explorer built i18n-correct) / P4 (legacy externalized) |
| F-A11Y | MEDIUM·ACCESSIBILITY | Layer picker: no `aria-expanded`/`aria-haspopup`, no `role`/label on panel, active-state by color only, no Esc/focus-management (WCAG 1.4.1, 4.1.2) | `SatelliteLayerControl.tsx:109,164,408` | P3 |
| F-WXTEST | MEDIUM·TECH-DEBT | Open-Meteo marine ingestion→persist→read path has zero behavioral tests (`OpenMeteoService.fetchMarineData`, `WeatherSyncService`, `WeatherCronService`, resolver marine/current) — why F-WX-01 survived | `weather/__tests__/` (only 1 handler spec) | per-phase |
| F-DOCLEAK | LOW·SECURITY | Docs publish a real Sentinel instance ID `b6b8c826-…` in plaintext while the entity classifies `instance_id` as an encrypted-at-rest secret | `docs/sentinel-hub-layers.md:6,207` | P0 (docs) |

_Checked and clean (recorded so they aren't re-audited): GraphQL sentinel field exposure is correct (`@HideField()` on tokens, secret columns carry no `@Field`); aquamobil does not consume the marine/map surface offline (only the programming term "sentinel value"); weather/marine tenant isolation is defense-in-depth via `search_path` pinning — a consistency wart (plain `@InjectRepository` vs the tenant-scoped boundary) but not an exploitable leak._

**On D5 (Open-Meteo stays out of the façade):** that decision is about *architecture*, not triage — F-WX-01 / F-WXDTO / F-WXTEST are live bugs and get fixed (P0 + tests) regardless of whether Open-Meteo ever joins the marine façade.

## Verification

- Implementation sessions verify per phase: `nx affected --target=test && nx affected --target=lint`; the named gate specs per phase (§6); P2 additionally `npm run type-check` (contract change); P4 grep-clean gate for legacy IDs.
- The verify stage's 135 recovered verdicts (130 confirmed / 5 refuted) settle nearly all findings as CONFIRMED-2L; only F-RACE, F-TZ, F-DEAD remain single-finder REPORTED and must be re-confirmed by reading the cited file:line before their fixing commit.
