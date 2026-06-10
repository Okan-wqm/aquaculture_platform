# Farm Service API

## Posture

Farm-service is an internal service behind `gateway-api`. Business API access is GraphQL-first. REST is retained for health, metrics, Sentinel Hub proxying, file transfer, streaming, and webhooks.

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

- `GET /health/live`
- `GET /health/ready`
- `GET /metrics`
- `GET /api/sentinel-hub/wms/{layerId}`
- `GET /api/sentinel-hub/process`
- `GET /api/sentinel-hub/catalog/search`

Domain CRUD and mutation REST routes are frozen. New business writes should be GraphQL mutations backed by CQRS commands.
