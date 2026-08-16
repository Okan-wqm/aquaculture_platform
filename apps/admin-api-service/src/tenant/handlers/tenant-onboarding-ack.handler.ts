import {
  assertServiceNatsHandlerSet,
  requireServiceNatsRuntimeProfile,
} from '@aquaculture/backend-common/nats';
import { queryRowsNormalized } from '@aquaculture/backend-common/database';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { IEvent, IEventBus, IEventHandler } from '@platform/event-bus';
import type {
  TenantOnboardingAckEvent,
  TenantOnboardingFailedEvent,
} from '@platform/event-contracts';
import {
  isTenantOnboardingAckEvent,
  isTenantOnboardingFailedEvent,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';

@Injectable()
export class TenantOnboardingAckHandler implements OnModuleInit {
  private readonly logger = new Logger(TenantOnboardingAckHandler.name);
  private readonly runtimeProfile = requireServiceNatsRuntimeProfile('admin-api-service');

  /**
   * The executable handler set. The runtime-profile assertion makes this exact:
   * neither catalog-only subscriptions nor ungoverned code-only handlers can
   * reach a running process.
   */
  private readonly eventHandlers = {
    TenantOnboardingAck: {
      getEventType: () => 'TenantOnboardingAck',
      handle: async (event: IEvent): Promise<void> => {
        if (!isTenantOnboardingAckEvent(event)) {
          throw new Error('TenantOnboardingAck payload failed its governed schema');
        }
        this.assertProducerAuthority(event);
        await this.handleAck(event);
      },
    },
    TenantOnboardingFailed: {
      getEventType: () => 'TenantOnboardingFailed',
      handle: async (event: IEvent): Promise<void> => {
        if (!isTenantOnboardingFailedEvent(event)) {
          throw new Error('TenantOnboardingFailed payload failed its governed schema');
        }
        this.assertProducerAuthority(event);
        await this.handleFailed(event);
      },
    },
  } satisfies Readonly<Record<string, IEventHandler<IEvent>>>;

  constructor(
    @Inject('EVENT_BUS')
    private readonly eventBus: Pick<IEventBus, 'subscribeWildcard'>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    assertServiceNatsHandlerSet(
      this.runtimeProfile,
      TenantOnboardingAckHandler.name,
      this.eventHandlers,
    );

    for (const subscription of this.runtimeProfile.subscriptions) {
      const handler = Object.values(this.eventHandlers).find(
        (candidate) => candidate.getEventType() === subscription.eventType,
      );
      if (!handler) {
        throw new Error(`No handler resolved for governed event ${subscription.eventType}`);
      }
      await this.eventBus.subscribeWildcard(subscription.eventType, handler, {
        consumerVersion: subscription.consumerVersion,
        durable: subscription.durable,
      });
    }

    this.logger.log(
      `Activated governed NATS profile ${this.runtimeProfile.profileDigest} with ${this.runtimeProfile.subscriptions.length} subscriptions`,
    );
  }

  private assertProducerAuthority(
    event: TenantOnboardingAckEvent | TenantOnboardingFailedEvent,
  ): void {
    const subscription = this.runtimeProfile.subscriptions.find(
      (candidate) => candidate.eventType === event.eventType,
    );
    if (!subscription || event.service !== subscription.producer) {
      throw new Error(
        `${event.eventType} service ${event.service} does not equal its governed producer`,
      );
    }
  }

  private async handleAck(event: TenantOnboardingAckEvent): Promise<void> {
    await this.record(
      event.operationId,
      event.tenantId,
      event.generation,
      event.service,
      'ACK',
      null,
      event.acknowledgedAt,
    );
  }

  private async handleFailed(event: TenantOnboardingFailedEvent): Promise<void> {
    await this.record(
      event.operationId,
      event.tenantId,
      event.generation,
      event.service,
      'FAILED',
      event.error,
      event.timestamp,
    );
  }

  private async record(
    operationId: string,
    tenantId: string,
    generation: number,
    service: string,
    status: 'ACK' | 'FAILED',
    error: string | null,
    acknowledgedAt: string,
  ): Promise<void> {
    const result: unknown = await this.dataSource.query(
      `SELECT admin.admit_tenant_onboarding_outcome(
         $1::uuid, $2::uuid, $3::integer, $4::text,
         $5::text, $6::text, $7::timestamptz
       ) AS disposition`,
      [operationId, tenantId, generation, service, status, error, acknowledgedAt],
    );
    const disposition = queryRowsNormalized<{
      disposition: 'ADMITTED' | 'DUPLICATE' | 'SAFETY_FAILED' | 'REJECTED_AFTER_ACTIVATION';
    }>(result)[0]?.disposition;
    if (disposition === 'SAFETY_FAILED' || disposition === 'REJECTED_AFTER_ACTIVATION') {
      throw new Error(
        `Tenant onboarding ${status} contradicts the immutable terminal outcome for generation ${generation}`,
      );
    }
    if (disposition !== 'ADMITTED' && disposition !== 'DUPLICATE') {
      throw new Error(`Tenant onboarding ${status} admission returned no governed disposition`);
    }
    this.logger.log(
      `Recorded tenant onboarding ${status} operation=${operationId} generation=${generation} service=${service} disposition=${disposition}`,
    );
  }
}
