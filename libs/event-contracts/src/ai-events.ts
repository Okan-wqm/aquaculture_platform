import { BaseEvent } from './base-event';

// ---- AI Agent Events ----

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

export interface AgentSuggestedAction {
  toolName: string;
  parameters: Record<string, unknown>;
  description: string;
  risk: string;                // 'low' | 'medium' | 'high'
}

export interface AgentApprovalRequestedEvent extends BaseEvent {
  eventType: 'AgentApprovalRequested';
  recommendationEventId: string;
  action: AgentSuggestedAction;
  expiresAt: string;             // Approval timeout
  requestedBy: string;         // Agent persona
  approverRoles: string[];     // Roles that can approve
}

export interface AgentActionExecutedEvent extends BaseEvent {
  eventType: 'AgentActionExecuted';
  approvalEventId?: string;    // If was approved by human
  toolName: string;
  parameters: Record<string, unknown>;
  result: Record<string, unknown>;
  executedBy: string;          // 'agent' | 'human_approved'
  offlineDecision: boolean;    // Was this from edge offline cache
}

export type AIEvent =
  | AgentAnalysisCompletedEvent
  | AgentRecommendationCreatedEvent
  | AgentApprovalRequestedEvent
  | AgentActionExecutedEvent;
