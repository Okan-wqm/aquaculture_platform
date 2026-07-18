# Marine Data Explorer — P0 defect batch (2026-07-18)

Phase P0 of the Marine Data Explorer plan (`docs/plans/2026-07-18-marine-data-explorer/PLAN.md`).
Root-cause fixes to the existing `/api/marine` + Sentinel/CMEMS + weather surface, landed
before the provider-façade (P1) and honest-contract (P2) work. Findings were surfaced by an
8-dimension adversarial review with 2-lens verification (135 verdicts, 130 confirmed / 5 refuted)
plus a coverage critic.

## HIGH — Sentinel functional breaks + weather zero-drop

- **Sentinel point-query always 400s** — `getSentinelPoint` requested a 1×1 render, but the shared
  process policy enforces `MIN_DIMENSION=64`, so every `sentinel:*` point query threw before reaching
  CDSE (`apps/farm-service/src/marine-data/marine-data.service.ts:239-243`,
  `apps/farm-service/src/sentinel-hub/sentinel-proxy.policy.ts:224-230`). Fixed by rendering a 64×64
  window and sampling the centre pixel; the single process policy is preserved.
- **Sentinel tiles 400 at the activation zoom** — `MAX_SENTINEL_TILE_MATRIX=18` admitted z≤8, but a
  z≤8 tile's bbox exceeds the policy's `MAX_BBOX_DEGREES_AREA=1`, so every low-zoom tile 400'd below
  ~60°N (all Turkish coasts) while the frontend activated Sentinel at z=8. Fixed by deriving the
  minimum servable zoom from the policy's area cap (single SSoT) and matching the frontend min zoom.
- **Upstream error piped into sharp → 500** — a non-image error body was decoded by sharp; now guarded.
- **Hardcoded `datasetId`** — the point response used a literal collection; now sourced from the registry.
- **`currentWeather` dropped exact-zero measurements** — truthy guards mapped genuine `0` (calm sea,
  0 °C, North = 0°, 0 mm precip, 0 % cloud) to `undefined`
  (`apps/farm-service/src/weather/weather.resolver.ts:113-125`). Fixed with a null-preserving coercion.

## MEDIUM — trust-boundary + hygiene

- **Unvalidated POST / mutation DTOs** — marine point-query/aoi bodies and the weather-settings input
  were plain interfaces, so the global `ValidationPipe` never ran. Replaced with class-validator DTOs.
- **Tenant imagery cached `public`** — the legacy Sentinel proxy set `Cache-Control: public` on
  per-tenant OAuth-credentialed responses (cross-tenant shared-cache leak vector). Flipped to `private`.
- **Phantom layers** — 6 advertised Sentinel layers mapped to null and error-toasted on select; removed
  from the layer catalog offered by the UI.
- **Mediterranean gate** — point queries were rejected outside a Europe bbox although the CMEMS products
  are global; the client-side gate was deleted.
- **Hardcoded instance ID in docs** — `docs/sentinel-hub-layers.md` published a real Sentinel instance
  ID in plaintext; redacted to a placeholder.
- **Schema-invariant gap** — `sentinel_hub_settings` (encrypted Copernicus creds) lacked the per-table
  `MOVED_TABLES` location assertion its siblings carry; added.

De-duplication: the two Sentinel process-request body builders were consolidated into a single factory.
