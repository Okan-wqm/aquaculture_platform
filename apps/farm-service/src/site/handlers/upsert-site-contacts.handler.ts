/**
 * UpsertSiteContactsHandler — Scope A Phase 4.4.3.
 *
 * Replaces the full set of site_contacts rows for one site in the
 * caller's tenant. The handler:
 *
 *   1. Pre-validates AT MOST ONE incoming contact has
 *      `isPrimary=true`. The DB has a partial unique index on
 *      `(siteId) WHERE isPrimary=true` that would catch this on
 *      INSERT, but failing fast at the handler gives a clearer
 *      error message and avoids spending a transaction round-trip.
 *   2. Executes inside `runInTenantTransaction` with tenant-scoped repos.
 *   3. Validates the site exists in the caller's tenant.
 *   4. Snapshots the previous contact rows for audit and event metadata.
 *   5. Deletes existing rows for `(tenantId, siteId)`.
 *   6. Inserts the new rows.
 *   7. Writes fail-closed audit and enqueues `SiteContactsChanged` in the
 *      same transaction, so the domain, audit, and event row commit together.
 *
 * Returns the post-write set of `SiteContact` rows.
 */
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createBaseEvent, type SiteContactsChangedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { UpsertSiteContactsCommand } from '../commands/upsert-site-contacts.command';
import { SiteContact } from '../entities/site-contact.entity';
import { Site } from '../entities/site.entity';

import { siteContactAuditSnapshot } from './site-audit.util';

@CommandHandler(UpsertSiteContactsCommand)
export class UpsertSiteContactsHandler
  implements ICommandHandler<UpsertSiteContactsCommand, SiteContact[]>
{
  private readonly logger = new Logger(UpsertSiteContactsHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly auditLogService: AuditLogService,
  ) {}

  async execute(command: UpsertSiteContactsCommand): Promise<SiteContact[]> {
    const { siteId, contacts, tenantId, userId } = command;

    this.logger.log(`Upserting ${contacts.length} contact(s) for site ${siteId}`);

    const primaryCount = contacts.filter((c) => c.isPrimary === true).length;
    if (primaryCount > 1) {
      throw new BadRequestException(
        `At most one contact may be marked isPrimary; got ${primaryCount}.`,
      );
    }

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const siteRepository = tenantManagerRepo(queryRunner.manager, Site, tenantId);
      const siteContactRepository = tenantManagerRepo(queryRunner.manager, SiteContact, tenantId);

      const site = await siteRepository.findOne({
        where: { id: siteId, tenantId },
      });
      if (!site) {
        throw new NotFoundException(`Site ${siteId} not found in tenant.`);
      }

      const previousRows = await siteContactRepository.find({
        where: { siteId, tenantId },
        order: { isPrimary: 'DESC', createdAt: 'ASC' },
      });
      const previousPrimaryContact = previousRows.find((r) => r.isPrimary);

      await siteContactRepository.delete({ siteId });

      const newRows: SiteContact[] = contacts.map((c) => {
        return siteContactRepository.create({
          siteId,
          name: c.name,
          role: c.role,
          email: c.email,
          phone: c.phone,
          isPrimary: c.isPrimary === true,
          createdBy: userId,
        });
      });
      const saved = newRows.length > 0 ? await siteContactRepository.saveMany(newRows) : [];
      const newPrimaryContact = saved.find((r) => r.isPrimary);

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Site',
        entityId: siteId,
        action: AuditAction.UPDATE,
        userId,
        changes: {
          before: {
            contacts: previousRows.map(siteContactAuditSnapshot),
          },
          after: {
            contacts: saved.map(siteContactAuditSnapshot),
          },
        },
        metadata: { source: 'SITES_SETUP' },
        entityVersion: site.version,
        summary: `Updated contacts for site ${site.code}`,
      });

      const event: SiteContactsChangedEvent = {
        ...createBaseEvent<SiteContactsChangedEvent>('SiteContactsChanged', tenantId, {
          aggregateId: siteId,
          aggregateType: 'Site',
          userId,
        }),
        siteId,
        previousContactCount: previousRows.length,
        newContactCount: saved.length,
        primaryContactChanged: previousPrimaryContact?.id !== newPrimaryContact?.id,
        changedBy: userId,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: siteId,
      });

      return saved;
    });
  }
}
