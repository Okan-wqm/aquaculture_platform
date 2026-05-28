# Farm Service Sentinel Hub Proxy

## Purpose

The proxy keeps Sentinel Hub OAuth tokens on the server. Browsers receive imagery or catalog responses, never provider credentials.

## Routes

- `GET /api/sentinel-hub/wms/{layerId}`: streams WMS image data.
- `GET /api/sentinel-hub/process`: calls Sentinel Hub Processing API.
- `GET /api/sentinel-hub/catalog/search`: calls STAC catalog search.

## Tenant Source

Tenant ID comes from authenticated request context only. The proxy does not accept tenant selection from query or body.

## Required Hardening

The canonical route model is allowlisted DTO input, server-side evalscript selection by enum, bounding-box limits, date-window limits, width and height caps, and response content-type allowlisting.

## Operations

- Rotate Sentinel Hub credentials through the secret key rotation runbook.
- Alert on provider 401, 403, and repeated 5xx responses.
- Cache imagery responses only when tenant and layer identity are part of the server cache key.
