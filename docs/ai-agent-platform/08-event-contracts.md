# 08 - Event Contracts

## Overview

AI agent events are defined in `libs/event-contracts/src/ai-events.ts` and extend the platform's `BaseEvent` interface from `libs/event-contracts/src/base-event.ts`.

## NATS Subject Pattern

All AI agent events follow the pattern:

```
ai.{tenantId}.{eventType}
```

Examples:
- `ai.tenant_abc.analysis.completed`
- `ai.tenant_abc.recommendation.created`
- `ai.tenant_abc.approval.requested`
- `ai.tenant_abc.action.executed`

## BaseEvent Fields

All events inherit from the platform's `BaseEvent` interface:

```typescript
interface BaseEvent {
  eventId: string;           // UUID v4
  eventType: string;         // e.g. 'AgentAnalysisCompleted'
  timestamp: string;         // ISO 8601
  tenantId: string;
  correlationId: string;     // Traces back to originating request/event
  userId?: string;           // The user who triggered this (if interactive)
}
```

## Event Types

### AgentAnalysisCompletedEvent

Emitted when an agent finishes a proactive or on-demand analysis of water quality, sensor data, or system state.

```typescript
export interface AgentAnalysisCompletedEvent extends BaseEvent {
  eventType: 'AgentAnalysisCompleted';
  analysisType: string;        // 'water_quality_check' | 'alert_escalation' | 'proactive_monitoring'
  persona: string;             // 'operator' | 'manager' | 'expert' | 'supervisor'
  triggerEventId?: string;     // ID of the event that triggered this analysis
  summary: string;             // Human-readable summary
  toolsUsed: string[];         // List of tool names invoked
  tokenUsage: number;          // Total tokens consumed
  durationMs: number;          // Processing time
}
```

**Subject:** `ai.{tenantId}.analysis.completed`

---

### AgentRecommendationCreatedEvent

Emitted when an agent produces an actionable recommendation based on analysis.

```typescript
export interface AgentRecommendationCreatedEvent extends BaseEvent {
  eventType: 'AgentRecommendationCreated';
  analysisEventId: string;     // Links to AgentAnalysisCompleted
  recommendation: string;      // What the agent recommends
  confidence: number;          // 0-1 confidence score
  category: string;            // 'dosing' | 'feeding' | 'alert' | 'maintenance'
  severity: string;            // 'info' | 'warning' | 'critical'
  requiresApproval: boolean;   // Whether human approval is needed
  suggestedActions: AgentSuggestedAction[];
}
```

---

### AgentSuggestedAction

Shared interface for suggested actions embedded in recommendations and approval requests.

```typescript
export interface AgentSuggestedAction {
  toolName: string;
  parameters: Record<string, unknown>;
  description: string;
  risk: string;                // 'low' | 'medium' | 'high'
}
```

---

### AgentApprovalRequestedEvent

Emitted when a tool with `requiresConfirmation: true` is about to execute and needs human approval. The agent pauses execution until an approval or rejection event is received.

```typescript
export interface AgentApprovalRequestedEvent extends BaseEvent {
  eventType: 'AgentApprovalRequested';
  recommendationEventId: string;
  action: AgentSuggestedAction;
  expiresAt: Date;             // Approval timeout
  requestedBy: string;         // Agent persona
  approverRoles: string[];     // Roles that can approve
}
```

**Subject:** `ai.{tenantId}.approval.requested`

---

### AgentActionExecutedEvent

Emitted when an approved action is executed.

```typescript
export interface AgentActionExecutedEvent extends BaseEvent {
  eventType: 'AgentActionExecuted';
  approvalEventId?: string;    // If was approved by human
  toolName: string;
  parameters: Record<string, unknown>;
  result: Record<string, unknown>;
  executedBy: string;          // 'agent' | 'human_approved'
  offlineDecision: boolean;    // Was this from edge offline cache
}
```

**Subject:** `ai.{tenantId}.action.executed`

---

## Union Type

All AI events are exported as a discriminated union:

```typescript
export type AIEvent =
  | AgentAnalysisCompletedEvent
  | AgentRecommendationCreatedEvent
  | AgentApprovalRequestedEvent
  | AgentActionExecutedEvent;
```

## Files

- `libs/event-contracts/src/ai-events.ts` - All AI event interfaces and the `AIEvent` union type
- `libs/event-contracts/src/base-event.ts` - `BaseEvent` interface
- `libs/event-contracts/src/index.ts` - Re-exports
