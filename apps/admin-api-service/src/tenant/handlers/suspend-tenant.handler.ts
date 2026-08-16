import * as crypto from 'crypto';

import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { canTransition } from '@platform/event-contracts';
import { Repository } from 'typeorm';
import {
  SuspendTenantCommand,
  ResumeTenantCommand,
  DeactivateTenantCommand,
  ArchiveTenantCommand,
} from '../commands/tenant.commands';
import { toTenantSummary } from '../dto/tenant-summary.dto';
import type { TenantSummaryDto } from '../dto/tenant-summary.dto';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import { AuthTenantProvisioningClientService } from '../services/auth-tenant-provisioning-client.service';

/**
 * Single-writer lifecycle handlers (DB-ADMIN-HIGH-004 / ORPHAN-HIGH-360).
 *
 * auth-service owns auth.tenants; every status transition (and the suspension
 * audit trio) is persisted by ITS TenantProvisioningCommandService under a
 * SERIALIZABLE receipt transaction. These handlers therefore:
 *
 *   1. pre-read the tenant WITHOUT a row lock — a fast-fail UX guard only.
 *      WHY no lock: the owner takes its own pessimistic lock on the same row
 *      inside the NATS command; holding a local FOR UPDATE across the
 *      request/reply would block the owner's write until the NATS timeout — a
 *      structural cross-service deadlock. The authoritative transition gate is
 *      the owner's lifecycle command map + canonical status machine, so losing
 *      the local lock loses no correctness.
 *   2. delegate the write to auth-service via NATS request/reply and treat the
 *      reply as the persistence receipt.
 *   3. re-read the fresh row the owner just committed (same DB) so the
 *      synchronous return contract stays truthful. The owner's immutable
 *      command receipt and TenantStatusChanged outbox row are the evidence;
 *      admin must not create a second lifecycle/audit authority.
 *
 * No handler here writes auth.tenants — enforced by
 * tests/invariants/admin-no-auth-tenants-writes.spec.ts.
 */

@Injectable()
@CommandHandler(SuspendTenantCommand)
export class SuspendTenantHandler
  implements ICommandHandler<SuspendTenantCommand, TenantSummaryDto>
{
  private readonly logger = new Logger(SuspendTenantHandler.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
  ) {}

  async execute(command: SuspendTenantCommand): Promise<TenantSummaryDto> {
    const { tenantId, data, suspendedBy } = command;

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID '${tenantId}' not found`);
    }

    // MT-HIGH-003: legality is owned by the tenant-status machine, not a
    // hand-coded equality. Only ACTIVE -> SUSPENDED is legal; any other
    // source state is rejected with the machine's allowed-set in the message.
    if (!canTransition(tenant.status, TenantStatus.SUSPENDED)) {
      throw new BadRequestException(
        `Cannot suspend a tenant in ${tenant.status} state — only ACTIVE tenants can be suspended.`,
      );
    }

    // The owner persists status + suspendedAt/suspendedReason/suspendedBy
    // (DB-ADMIN-HIGH-003) atomically; a non-success reply throws before any
    // local side effect.
    await this.authProvisioningClient.suspendTenant({
      ...buildLifecycleCommandMetadata('SuspendTenant', tenantId, suspendedBy, {
        reason: data.reason,
      }),
      reason: data.reason,
    });

    const refreshed = await requireFreshTenantRow(this.tenantRepository, tenantId, 'suspension');
    this.logger.warn(`Tenant suspended: ${tenantId} by ${suspendedBy}. Reason: ${data.reason}`);
    return toTenantSummary(refreshed);
  }
}

@Injectable()
@CommandHandler(ResumeTenantCommand)
export class ResumeTenantHandler implements ICommandHandler<ResumeTenantCommand, TenantSummaryDto> {
  private readonly logger = new Logger(ResumeTenantHandler.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
  ) {}

  async execute(command: ResumeTenantCommand): Promise<TenantSummaryDto> {
    const { tenantId, resumedBy } = command;

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID '${tenantId}' not found`);
    }

    // Resumption is deliberately narrower than the canonical machine edge set:
    // onboarding owns PROVISIONING -> ACTIVE and only a sealed ActivateTenant
    // may drive it. This command owns SUSPENDED -> ACTIVE only.
    if (tenant.status !== TenantStatus.SUSPENDED) {
      throw new BadRequestException(
        `Cannot resume a tenant in ${tenant.status} state — only SUSPENDED tenants can be resumed.`,
      );
    }

    // The owner persists status = ACTIVE and clears the suspension audit trio
    // (DB-ADMIN-HIGH-003) atomically.
    await this.authProvisioningClient.resumeTenant({
      ...buildLifecycleCommandMetadata('ResumeTenant', tenantId, resumedBy, {}),
    });

    const refreshed = await requireFreshTenantRow(this.tenantRepository, tenantId, 'activation');
    this.logger.log(`Tenant resumed: ${tenantId} by ${resumedBy}`);
    return toTenantSummary(refreshed);
  }
}

@Injectable()
@CommandHandler(DeactivateTenantCommand)
export class DeactivateTenantHandler
  implements ICommandHandler<DeactivateTenantCommand, TenantSummaryDto>
{
  private readonly logger = new Logger(DeactivateTenantHandler.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
  ) {}

  async execute(command: DeactivateTenantCommand): Promise<TenantSummaryDto> {
    const { tenantId, reason, deactivatedBy } = command;

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID '${tenantId}' not found`);
    }

    // MT-HIGH-003: only ACTIVE/SUSPENDED -> DEACTIVATED is legal. This also
    // rejects the already-DEACTIVATED idempotent case and the archived/
    // terminal states the hand-coded pair used to special-case.
    if (!canTransition(tenant.status, TenantStatus.DEACTIVATED)) {
      throw new BadRequestException(
        `Cannot deactivate a tenant in ${tenant.status} state — only ACTIVE or SUSPENDED tenants can be deactivated.`,
      );
    }

    await this.authProvisioningClient.deprovisionTenant({
      ...buildLifecycleCommandMetadata('DeprovisionTenant', tenantId, deactivatedBy, { reason }),
      reason,
    });

    const refreshed = await requireFreshTenantRow(this.tenantRepository, tenantId, 'deactivation');
    this.logger.warn(`Tenant deactivated: ${tenantId} by ${deactivatedBy}`);
    return toTenantSummary(refreshed);
  }
}

@Injectable()
@CommandHandler(ArchiveTenantCommand)
export class ArchiveTenantHandler
  implements ICommandHandler<ArchiveTenantCommand, TenantSummaryDto>
{
  private readonly logger = new Logger(ArchiveTenantHandler.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly authProvisioningClient: AuthTenantProvisioningClientService,
  ) {}

  async execute(command: ArchiveTenantCommand): Promise<TenantSummaryDto> {
    const { tenantId, archivedBy } = command;

    const tenant = await this.tenantRepository.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant with ID '${tenantId}' not found`);
    }

    // MT-HIGH-003: only SUSPENDED/DEACTIVATED/CANCELLED -> ARCHIVED is legal.
    // An ACTIVE tenant must be suspended or deactivated first; already-archived
    // and provisioning/terminal states are rejected by the same machine rule.
    if (!canTransition(tenant.status, TenantStatus.ARCHIVED)) {
      throw new BadRequestException(
        `Cannot archive a tenant in ${tenant.status} state — suspend or deactivate it first ` +
          `(legal sources: SUSPENDED, DEACTIVATED, CANCELLED).`,
      );
    }

    await this.authProvisioningClient.archiveTenant({
      ...buildLifecycleCommandMetadata('ArchiveTenant', tenantId, archivedBy, {}),
    });

    const refreshed = await requireFreshTenantRow(this.tenantRepository, tenantId, 'archival');
    this.logger.warn(`Tenant archived: ${tenantId} by ${archivedBy}`);
    return toTenantSummary(refreshed);
  }
}

/**
 * Re-read the tenant row the owner (auth-service) just committed.
 *
 * WHY a re-read instead of mutating the pre-read entity: admin-api no longer
 * writes auth.tenants (single-writer, DB-ADMIN-HIGH-004), so the only truthful
 * source for the post-transition row — including the owner-written suspension
 * audit trio — is the table itself. Both services share one Postgres, and the
 * owner commits before its NATS reply, so this read observes the transition.
 * The null branch is unreachable after a successful owner reply for an
 * existing tenant (rows are never hard-deleted by lifecycle transitions), but
 * findOne's contract is `Tenant | null` and a vanished row must surface as an
 * error, not a fabricated entity.
 */
async function requireFreshTenantRow(
  tenantRepository: Pick<Repository<Tenant>, 'findOne'>,
  tenantId: string,
  transitionLabel: string,
): Promise<Tenant> {
  const refreshed = await tenantRepository.findOne({
    where: { id: tenantId },
  });
  if (!refreshed) {
    throw new NotFoundException(
      `Tenant with ID '${tenantId}' not found after ${transitionLabel} was confirmed by auth-service`,
    );
  }
  return refreshed;
}

function buildLifecycleCommandMetadata(
  commandType: string,
  tenantId: string,
  actorId: string,
  _payload: unknown,
): {
  operationId: string;
  tenantId: string;
  actor: { id: string; type: 'user' };
  requestReference: string;
  auditMetadata: Record<string, unknown>;
} {
  const operationId = crypto.randomUUID();
  return {
    operationId,
    tenantId,
    actor: { id: actorId, type: 'user' },
    requestReference: `${commandType}:${tenantId}:${actorId}`,
    auditMetadata: {
      source: 'admin-api-service',
      commandType,
    },
  };
}
