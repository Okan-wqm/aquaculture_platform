# Farm RBAC Permission Matrix

## Principle

Farm-service authorization is fail-closed. Every GraphQL root operation and retained REST route needs an explicit matrix entry.

## Roles

- `SUPER_ADMIN`: platform break-glass and audited cross-tenant operations.
- `TENANT_ADMIN`: tenant administration, integrations, regulatory settings.
- `MODULE_MANAGER`: farm operations management.
- `OPERATOR`: day-to-day farm execution.
- `VIEWER`: read-only farm visibility.
- `SERVICE`: signed service-to-service calls through gateway or approved service identity.

## Operation Classes

| Class                | Examples                                                  | Minimum Role           |
| -------------------- | --------------------------------------------------------- | ---------------------- |
| Read farm state      | farms, sites, tanks, batches, stock, weather              | VIEWER                 |
| Operational write    | mortality, cull, transfer, feeding, growth, water quality | OPERATOR               |
| Planning write       | harvest plans, feeding programs, maintenance schedules    | MODULE_MANAGER         |
| Reference data write | species, suppliers, equipment catalogs, departments       | MODULE_MANAGER         |
| Integration secrets  | Sentinel Hub, regulatory credentials                      | TENANT_ADMIN           |
| Cross-tenant action  | impersonation, tenant export, erasure                     | SUPER_ADMIN plus audit |

## Enforcement

Runtime enforcement is `PermissionMatrixGuard`. Source coverage lives under `apps/farm-service/src/common/authz`.
