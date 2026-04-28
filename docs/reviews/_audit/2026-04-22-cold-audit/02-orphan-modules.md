# Orphan / circular module candidates

Cycle: `2026-04-22-cold-audit`.

## Circular dependency chains (madge)

Total: **26** chains. Each is a candidate for refactor OR a TypeORM forward-reference that madge can't statically resolve — Phase 2 agent must distinguish.

1. `apps/admin-api-service/src/users/entities/tenant-role-permissions.entity.ts` → `apps/admin-api-service/src/users/entities/tenant-role.entity.ts`
2. `apps/ai-service/src/agent/agent-profile.service.ts` → `apps/ai-service/src/agent/personas/expert.ts`
3. `apps/ai-service/src/agent/agent-profile.service.ts` → `apps/ai-service/src/agent/personas/manager.ts`
4. `apps/ai-service/src/agent/agent-profile.service.ts` → `apps/ai-service/src/agent/personas/operator.ts`
5. `apps/ai-service/src/agent/agent-profile.service.ts` → `apps/ai-service/src/agent/personas/supervisor.ts`
6. `apps/alert-engine/src/risk-scoring/risk-calculator.service.ts` → `apps/alert-engine/src/risk-scoring/severity-classifier.service.ts`
7. `apps/billing-service/src/billing/entities/invoice.entity.ts` → `apps/billing-service/src/billing/entities/subscription.entity.ts`
8. `apps/billing-service/src/billing/entities/subscription.entity.ts` → `apps/billing-service/src/billing/entities/subscription-module-item.entity.ts`
9. `apps/billing-service/src/modules/metering/entities/usage-aggregation.entity.ts` → `apps/billing-service/src/modules/metering/usage-aggregator.service.ts`
10. `apps/farm-service/src/batch/entities/batch.entity.ts` → `apps/farm-service/src/batch/entities/batch-document.entity.ts`
11. `apps/farm-service/src/equipment/entities/equipment.entity.ts` → `apps/farm-service/src/equipment/entities/equipment-system.entity.ts`
12. `apps/farm-service/src/farm/entities/pond.entity.ts` → `apps/farm-service/src/farm/entities/farm.entity.ts`
13. `apps/farm-service/src/feeding/entities/feeding-program-tank.entity.ts` → `apps/farm-service/src/feeding/entities/feeding-program.entity.ts`
14. `apps/farm-service/src/storage/entities/inventory-count-item.entity.ts` → `apps/farm-service/src/storage/entities/inventory-count.entity.ts`
15. `apps/farm-service/src/storage/entities/purchase-order-item.entity.ts` → `apps/farm-service/src/storage/entities/purchase-order.entity.ts`
16. `apps/gateway-api/src/services/tenant-lookup.service.ts` → `apps/gateway-api/src/middleware/tenant-context.middleware.ts`
17. `apps/gateway-api/src/guards/permission.guard.ts` → `apps/gateway-api/src/guards/permission.helpers.ts`
18. `apps/hr-service/src/hr/entities/employee.entity.ts` → `apps/hr-service/src/hr/entities/payroll.entity.ts`
19. `apps/hr-service/src/scheduling/entities/weekly-plan-entry.entity.ts` → `apps/hr-service/src/scheduling/entities/weekly-plan.entity.ts`
20. `apps/messaging-service/src/message/entities/message.entity.ts` → `apps/messaging-service/src/message/entities/message-attachment.entity.ts`
21. `apps/messaging-service/src/message/entities/message.entity.ts` → `apps/messaging-service/src/message/entities/message-reaction.entity.ts`
22. `apps/messaging-service/src/message/entities/message.entity.ts` → `apps/messaging-service/src/message/entities/message-receipt.entity.ts`
23. `apps/messaging-service/src/channel/entities/channel-member.entity.ts` → `apps/messaging-service/src/channel/entities/channel.entity.ts`
24. `apps/sensor-service/src/vfd-programming/entities/vfd-change-set-item.entity.ts` → `apps/sensor-service/src/vfd-programming/entities/vfd-change-set.entity.ts`
25. `platform/libs/event-bus/src/nats/nats-event-bus.ts` → `platform/libs/event-bus/src/nats/nats.module.ts`
26. `platform/libs/event-bus/src/nats/nats-event-bus.ts` → `platform/libs/event-bus/src/nats/nats.module.ts` → `platform/libs/event-bus/src/nats/nats-request-reply.ts`

## Candidate dead-code

_Populated by Phase 2 agent via grep confirmation against `nx graph` results._
