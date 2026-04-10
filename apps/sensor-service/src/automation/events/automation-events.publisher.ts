import { Injectable, Logger, Inject, Optional } from '@nestjs/common';

import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';

import {
  NATS_EVENTS,
  buildEventSubject,
} from '../compiler/compiler.constants';
import {
  NatsEventProgramSaved,
  NatsEventProgramDeployed,
  NatsEventTagsUpdated,
  NatsEventFBDefinitionsChanged,
} from '../compiler/compiler.types';

/**
 * Automation Events Publisher
 *
 * Publishes automation-related events to NATS JetStream.
 * These events are consumed by:
 * - gateway-api: Pushes to connected WS clients (IntelliSense cache invalidation)
 * - Other services: Audit logging, notifications
 */
@Injectable()
export class AutomationEventsPublisher {
  private readonly logger = new Logger(AutomationEventsPublisher.name);

  constructor(
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: NatsEventBus | null,
  ) {}

  publishProgramSaved(
    tenantId: string,
    programId: string,
    programCode: string,
    version: number,
    savedBy: string,
  ): void {
    if (!this.eventBus?.isConnected()) {
      this.logger.debug('Event bus not connected, skipping ProgramSaved event');
      return;
    }

    const event: NatsEventProgramSaved = {
      tenantId,
      programId,
      programCode,
      version,
      savedBy,
      savedAt: new Date().toISOString(),
    };

    this.eventBus
      .publishTo(
        buildEventSubject(NATS_EVENTS.PROGRAM_SAVED, tenantId),
        {
          ...createBaseEvent('AutomationProgramSaved', tenantId, { aggregateId: programId, aggregateType: 'AutomationProgram' }),
          ...event,
        },
      )
      .catch((err) =>
        this.logger.error(
          `Failed to publish ProgramSaved event: ${err.message}`,
        ),
      );
  }

  publishProgramDeployed(
    tenantId: string,
    programId: string,
    programCode: string,
    version: number,
    deployedBy: string,
    targetDevice?: string,
  ): void {
    if (!this.eventBus?.isConnected()) {
      this.logger.debug(
        'Event bus not connected, skipping ProgramDeployed event',
      );
      return;
    }

    const event: NatsEventProgramDeployed = {
      tenantId,
      programId,
      programCode,
      version,
      deployedBy,
      deployedAt: new Date().toISOString(),
      targetDevice,
    };

    this.eventBus
      .publishTo(
        buildEventSubject(NATS_EVENTS.PROGRAM_DEPLOYED, tenantId),
        {
          ...createBaseEvent('AutomationProgramDeployed', tenantId, { aggregateId: programId, aggregateType: 'AutomationProgram' }),
          ...event,
        },
      )
      .catch((err) =>
        this.logger.error(
          `Failed to publish ProgramDeployed event: ${err.message}`,
        ),
      );
  }

  publishTagsUpdated(
    tenantId: string,
    added?: string[],
    removed?: string[],
    updated?: string[],
  ): void {
    if (!this.eventBus?.isConnected()) {
      this.logger.debug(
        'Event bus not connected, skipping TagsUpdated event',
      );
      return;
    }

    const event: NatsEventTagsUpdated = {
      tenantId,
      added,
      removed,
      updated,
    };

    this.eventBus
      .publishTo(
        buildEventSubject(NATS_EVENTS.TAGS_UPDATED, tenantId),
        {
          ...createBaseEvent('AutomationTagsUpdated', tenantId),
          ...event,
        },
      )
      .catch((err) =>
        this.logger.error(
          `Failed to publish TagsUpdated event: ${err.message}`,
        ),
      );
  }

  publishFBDefinitionsChanged(
    tenantId: string,
    changedFBs: string[],
  ): void {
    if (!this.eventBus?.isConnected()) {
      this.logger.debug(
        'Event bus not connected, skipping FBDefinitionsChanged event',
      );
      return;
    }

    const event: NatsEventFBDefinitionsChanged = {
      tenantId,
      changedFBs,
    };

    this.eventBus
      .publishTo(
        buildEventSubject(NATS_EVENTS.FB_DEFINITIONS_CHANGED, tenantId),
        {
          ...createBaseEvent('AutomationFBDefinitionsChanged', tenantId),
          ...event,
        },
      )
      .catch((err) =>
        this.logger.error(
          `Failed to publish FBDefinitionsChanged event: ${err.message}`,
        ),
      );
  }
}
