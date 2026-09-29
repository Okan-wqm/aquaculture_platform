import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { HandlerOutcome, IEventBus, IEventHandler, outcomeForError } from '@platform/event-bus';
import { requireTenantScope, type TenantProvisionedEvent } from '@platform/event-contracts';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';

import { ensureDefaultEscalationPolicy } from './default-escalation-policy';
import { EscalationPolicyService } from './escalation-policy.service';

/**
 * Seeds a newly provisioned tenant's default escalation policy
 * (ALERT-CRITICAL-004, edge trigger).
 *
 * WHY `TenantProvisioned`: it is published after the tenant's schemas, RLS
 * and activation are committed, so the per-tenant `escalation_policies` table
 * exists. The seed is idempotent (see `ensureDefaultEscalationPolicy`), so a
 * redelivery, the periodic reconcile and the point-of-use ensure never mint a
 * second default. A delivery that still fails is re-driven by the bus and, if
 * its budget runs out, the reconcile covers the tenant on its next tick.
 *
 * NATS: consuming a wildcard `events.*.TenantProvisioned` needs no
 * services.yaml subscribe row — the durable consumer is created through the
 * JetStream API grants alert_engine already holds.
 */
@Injectable()
export class DefaultPolicyProvisioningHandler
  implements IEventHandler<TenantProvisionedEvent>, OnModuleInit
{
  private readonly logger = new Logger(DefaultPolicyProvisioningHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(EscalationPolicyService)
    private readonly policyService: Pick<EscalationPolicyService, 'invalidateCache'>,
    @Inject('EVENT_BUS')
    private readonly eventBus: Pick<IEventBus, 'subscribeWildcard'>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.eventBus.subscribeWildcard('TenantProvisioned', this);
    this.logger.log('Subscribed to TenantProvisioned to seed default escalation policies');
  }

  getEventType(): string {
    return 'TenantProvisioned';
  }

  async handle(event: TenantProvisionedEvent): Promise<HandlerOutcome> {
    // PLAT-MEDIUM-910: the tenancy scope is PARSED, not hand-guarded. A tenant id
    // becomes a schema name, so anything but a tenant UUID (the platform segment
    // included) is refused — and a malformed one is dead-lettered, not acked.
    let tenantId: string;
    try {
      ({ tenantId } = requireTenantScope(event));
    } catch (error) {
      return outcomeForError('TenantProvisioned default escalation policy', error);
    }

    try {
      const outcome = await runInTenantTransaction(
        this.dataSource,
        'alert',
        tenantId,
        (queryRunner) => ensureDefaultEscalationPolicy(queryRunner.manager, tenantId),
      );
      if (outcome === 'created') {
        this.policyService.invalidateCache(tenantId);
      }
      this.logger.log(
        `Default escalation policy ${outcome} for tenant ${tenantId.substring(0, 8)}...`,
      );
      return HandlerOutcome.ack();
    } catch (error) {
      this.logger.error(
        `Default escalation policy seed failed for tenant ${tenantId.substring(0, 8)}...: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      // The periodic reconcile re-derives this from live state, but a new
      // tenant should not wait for it: retry within the delivery budget.
      return outcomeForError('TenantProvisioned default escalation policy', error);
    }
  }
}
