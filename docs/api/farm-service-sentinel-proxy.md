# Farm Service Sentinel Imagery Contract

## Purpose

The site-bound pipeline keeps CDSE OAuth credentials on the server. Browsers receive an exact-scene PNG for a site they are authorized to view, never provider credentials or an arbitrary upstream proxy.

## Routes

- `POST /api/internal/marine/sites/{siteId}/render`: streams one previously catalogued scene over the site's current monitoring area.
- `GET /api/sentinel-hub/wms/{layerId}`: retired; authenticated requests receive HTTP 410.
- `GET /api/sentinel-hub/process`: retired; authenticated requests receive HTTP 410.
- `GET /api/sentinel-hub/catalog/search`: retired; authenticated requests receive HTTP 410.

## Tenant Source

Tenant ID, user identity, roles, and assigned sites come from the gateway-signed request context only. The route does not accept tenant selection from query or body.

## Required Hardening

The canonical route model is allowlisted DTO input, server-side product selection, a persisted exact-scene proof, site-owned monitoring geometry, width and height caps, PNG content-type allowlisting, a shared 15 MiB response ceiling, backpressure, and client-disconnect cancellation.

## Operations

- Rotate Sentinel Hub credentials through the secret key rotation runbook.
- Alert on provider 401, 403, and repeated 5xx responses.
- Cache imagery responses only when tenant and layer identity are part of the server cache key.
