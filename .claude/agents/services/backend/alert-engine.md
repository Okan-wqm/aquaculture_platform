---
name: alert-engine
description: Knowledge base for alert-engine - Rules engine, risk scoring, escalation, notification dispatch for aquaculture monitoring alerts
---

# Alert Engine Knowledge Base

## Overview
The alert-engine processes sensor readings and farm events to evaluate alert rules, score risk levels, escalate incidents, and dispatch notifications. It maintains a rules engine that can use JSON-based rules, OPA (Open Policy Agent) policies, and behavior trees. Alerts are persisted as incidents with full timeline tracking. Port 3004 in local dev (alert subgraph).

## Directory Structure
```
apps/alert-engine/src/
  app.module.ts              # Root - TypeORM (no fixed schema), GraphQL Fed v2, NATS, Redis
  main.ts
  filters/
    global-exception.filter.ts

  alert/
    alert.module.ts
    alert.resolver.ts          # GraphQL resolver for alert management
    services/
      alert-rule.service.ts    # CRUD for alert rules
      alert-evaluation.service.ts  # Evaluates readings against rules
    event-handlers/
      sensor-reading.handler.ts  # Consumes SensorReadingIngested NATS events
    entities/
      alert-history.entity.ts   # Historical alert records
    dto/
      create-alert-rule.dto.ts

  database/
    entities/
      alert-rule.entity.ts      # Rule definition with conditions
      alert-incident.entity.ts  # Active/resolved incidents with timeline
      escalation-policy.entity.ts  # Escalation policy definitions

  rules-engine/
    rules-engine.service.ts     # Orchestrates rule evaluation
    rule-evaluator.service.ts   # Evaluates individual rules
    json-rules.service.ts       # JSON-based rule DSL evaluation
    opa-rules.service.ts        # OPA policy-based rule evaluation
    behavior-tree.service.ts    # Behavior tree rule evaluation

  risk-scoring/
    risk-calculator.service.ts  # Calculates overall risk score
    impact-analyzer.service.ts  # Analyzes potential impact of condition
    severity-classifier.service.ts  # Classifies alert severity (LOW/MEDIUM/HIGH/CRITICAL)

  escalation/
    escalation-policy.service.ts     # Manages escalation policies
    escalation-manager.service.ts    # Triggers escalation chains
    acknowledgment-tracker.service.ts  # Tracks who acknowledged alerts

  notification/
    notification-dispatcher.service.ts  # Dispatches to notification-service via NATS
    template-renderer.service.ts        # Renders notification templates
    channel-router.service.ts           # Routes to appropriate channels (email/SMS/push)

  audit/
    alert-audit.service.ts      # Audit trail for alert actions

  health/
    health.module.ts
    health.controller.ts
```

## Modules & Features

### AlertModule
- `AlertRuleService`: CRUD for alert rules (create, update, enable/disable, delete)
- `AlertEvaluationService`: evaluates incoming sensor readings against active rules
- `SensorReadingHandler`: NATS event handler consuming `SensorReadingIngested` events
- `AlertResolver`: GraphQL queries/mutations for alert management

### RulesEngine
- `RulesEngineService`: orchestrates multi-engine rule evaluation
- `RuleEvaluatorService`: evaluates a single rule against a context
- `JsonRulesService`: evaluates rules defined as JSON DSL (threshold, range, rate-of-change conditions)
- `OpaRulesService`: delegates complex rules to OPA (Open Policy Agent)
- `BehaviorTreeService`: evaluates rules organized as behavior trees (composite conditions)

### RiskScoring
- `RiskCalculatorService`: computes composite risk score from multiple factors
- `ImpactAnalyzerService`: assesses potential impact (biomass loss, regulatory violation, etc.)
- `SeverityClassifierService`: classifies as LOW, MEDIUM, HIGH, CRITICAL based on risk score and impact

### Escalation
- `EscalationPolicyService`: defines escalation chains (who to notify at each level)
- `EscalationManager`: triggers escalation after timeout if not acknowledged
- `AcknowledgmentTracker`: records who acknowledged an incident and when

### Notification
- `NotificationDispatcher`: sends NATS events to notification-service for actual dispatch
- `TemplateRenderer`: renders alert message templates with sensor context
- `ChannelRouter`: decides email vs SMS vs push based on severity and user preferences; includes rate limiting

### AuditModule
- Records all alert lifecycle events (created, escalated, acknowledged, resolved)

## Key Entities

### AlertRule
- `name`, `description`, `tenantId`, `isEnabled`
- `conditions`: array of `AlertCondition` (JSONB) defining thresholds
  - `AlertCondition`: `{ metric, operator (gt/lt/eq/between), value, duration }`
- `severity`: LOW | MEDIUM | HIGH | CRITICAL
- `escalationPolicyId`
- `actions`: what to do when triggered (notify, webhook, etc.)

### AlertIncident
- `ruleId`, `tenantId`, `status` (OPEN, ACKNOWLEDGED, RESOLVED, SUPPRESSED)
- `severity`, `riskScore`
- `timeline`: array of `IncidentTimelineEvent` (JSONB) - tracks all state changes
- `acknowledgedBy`, `acknowledgedAt`, `resolvedAt`
- Registered as orphaned type: `IncidentTimelineEvent`

### EscalationPolicy
- `name`, `tenantId`
- `levels`: escalation steps with delay and recipients per level

### AlertHistory
- Historical record of past alerts (for trend analysis)

## API / GraphQL (alert subgraph)
The `alert.resolver.ts` exposes alert management via GraphQL.

### Key Queries
- `alertRules`, `alertRule`
- `alertIncidents`, `alertIncident`, `activeIncidents`
- `alertHistory`, `alertStats`

### Key Mutations
- `createAlertRule`, `updateAlertRule`, `deleteAlertRule`
- `enableAlertRule`, `disableAlertRule`
- `acknowledgeIncident`
- `resolveIncident`
- `suppressIncident`
- `createEscalationPolicy`, `updateEscalationPolicy`

## Patterns Used
- **Event-driven**: consumes `SensorReadingIngested` from NATS, evaluates rules
- **Multi-engine rules**: JSON DSL + OPA + behavior trees for different rule types
- **Risk-based severity**: numeric risk score determines severity classification
- **Escalation chains**: configurable per-tenant escalation policies with timeouts
- **TenantGuard**: tenant isolation enforced globally
- **Redis**: distributed state for rate limiting and incident deduplication
- **TenantSchemaMiddleware**: tenant schema isolation (search_path `"tenant_xxx", alert, public`)

## Inter-Service Communication
Consumes NATS events:
- `SensorReadingIngested` (from sensor-service)
- `BatchCreated`, `FishHealthRecorded` (from farm-service)

Publishes NATS events:
- `AlertTriggered` (consumed by notification-service)
- `AlertEscalated`
- `AlertResolved`

## Key Dependencies
- `@platform/event-bus` - NATS JetStream
- `@platform/backend-common` - TenantGuard, middleware
- Redis (`keyPrefix: 'alert:'`) - incident deduplication, rate limiting
- OPA client (external OPA service or embedded)

## Known Gotchas
- **Orphaned GraphQL types**: `IncidentTimelineEvent` and `AlertCondition` are embedded JSONB types that must be registered in `buildSchemaOptions.orphanedTypes` - already done in `app.module.ts`
- **No fixed schema** - like farm-service, alert-engine uses dynamic search_path; never add explicit schema to entity decorators
- **Channel router rate limiting** - `channel-router-rate-limit.spec.ts` exists as a dedicated test; the rate limiter prevents notification storms
- **OPA is optional** - if OPA service is not available, falls back to JSON rules only
- **Incident deduplication** - Redis used to prevent creating multiple incidents for the same rule if readings keep triggering it

## Related Services
- sensor-service: source of `SensorReadingIngested` events
- farm-service: source of farm-level events
- notification-service: receives `AlertTriggered` to send actual notifications
- gateway-api: GraphQL access for alert management UI
