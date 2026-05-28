# Service Identity V2 Rollout

## Goal

All production requests from gateway to farm-service carry v2 service identity proof bound to method, path, body hash, timestamp, and tenant header.

## Steps

1. Set `INTERNAL_SERVICE_SECRET` for gateway and farm-service from the same secret source.
2. Enable gateway signed outbound requests.
3. Verify farm-service accepts signed GraphQL requests.
4. Verify unsigned direct GraphQL requests return 403 in production.
5. Verify forged internal headers are stripped before user and tenant middleware.
6. Monitor service identity rejection logs for unknown callers.

## Validation

Run a direct request with `x-user-payload` and no valid signature. The request must not create user or tenant context from that header.
