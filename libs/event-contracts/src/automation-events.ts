import { BaseEvent } from './base-event';

/**
 * Automation domain events — sensor-service compiler / programming events.
 *
 * # Why this file exists
 *
 * ORPHAN-EVENT-CONTRACT-015..018 cure: 4 automation events emitted from
 * apps/sensor-service/src/automation/events/automation-events.publisher.ts
 * had no canonical interface — producer could mutate the payload shape
 * without consumer-side compile breaks. Field shapes derived from the
 * existing `NatsEvent*` types in
 * apps/sensor-service/src/automation/compiler/compiler.types.ts.
 *
 * # Canonical vs local types
 *
 * The local NatsEvent* types stay (they describe the publisher-side
 * payload spread shape). The canonical event-contract interfaces here
 * describe the on-the-wire BaseEvent envelope that includes timestamp,
 * eventId, tenantId, aggregateId fields.
 */

export interface AutomationProgramSavedEvent extends BaseEvent {
  eventType: 'AutomationProgramSaved';
  programId: string;
  programCode: string;
  version: number;
  savedBy: string;
  savedAt: string;
}

export interface AutomationProgramDeployedEvent extends BaseEvent {
  eventType: 'AutomationProgramDeployed';
  programId: string;
  programCode: string;
  version: number;
  deployedBy: string;
  deployedAt: string;
  targetDevice?: string;
}

export interface AutomationTagsUpdatedEvent extends BaseEvent {
  eventType: 'AutomationTagsUpdated';
  added?: string[];
  removed?: string[];
  updated?: string[];
}

export interface AutomationFBDefinitionsChangedEvent extends BaseEvent {
  eventType: 'AutomationFBDefinitionsChanged';
  changedFBs: string[];
}

export type AutomationEvent =
  | AutomationProgramSavedEvent
  | AutomationProgramDeployedEvent
  | AutomationTagsUpdatedEvent
  | AutomationFBDefinitionsChangedEvent;
