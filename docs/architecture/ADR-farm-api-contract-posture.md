# ADR: Farm API Contract Posture

## Status

Accepted.

## Decision

Farm-service is GraphQL-first for business reads and writes. REST is retained for operational and proxy paths only:

- `/health/live`
- `/health/ready`
- `/metrics`
- `/api/sentinel-hub/**`
- upload, download, streaming, and webhook paths with explicit OpenAPI contracts

New REST domain CRUD or mutation routes are not accepted without an ADR update, OpenAPI coverage, request DTO validation, response DTOs, and an RBAC matrix entry.

## Rationale

A single business API model reduces authorization drift, tenant source drift, and frontend contract drift. Federation also lets gateway checks and subgraph checks share the same operation model.

## Consequences

- Farm GraphQL SDL is committed at `apps/farm-service/schema.graphql`.
- Frontend codegen and gateway composition must fail on schema drift.
- REST paths that remain must be documented in `docs/api/openapi/farm-service.yaml`.
