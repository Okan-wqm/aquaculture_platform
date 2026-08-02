# Farm Service API

## Posture

Farm-service is an internal service behind `gateway-api`. Business API access is GraphQL-first. REST is retained for health, metrics, bounded binary transfer, streaming, and webhooks.

## GraphQL

Committed SDL snapshot: `apps/farm-service/schema.graphql`.

Root operations must have:

- DTO validation or input type validation.
- Permission matrix entry.
- Tenant source from verified request context.
- Stable error code for client-facing failures.

## REST

OpenAPI contract: `docs/api/openapi/farm-service.yaml`.

Supported retained paths:

- `GET /health`
- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`
- `POST /api/internal/marine/sites/{siteId}/render`

The render route accepts only an authorized site, a backend-catalogued exact scene ID, and an approved Sentinel imagery layer. It never accepts provider credentials or tenant selection. The former browser-directed Sentinel and non-site-bound marine routes are authenticated HTTP 410 tombstones.

Domain CRUD and mutation REST routes are frozen. New business writes should be GraphQL mutations backed by CQRS commands.
