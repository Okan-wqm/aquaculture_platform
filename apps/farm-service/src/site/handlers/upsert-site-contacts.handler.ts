/**
 * UpsertSiteContactsHandler — Scope A Phase 4.4.3.
 *
 * Replaces the full set of site_contacts rows for one site in the
 * caller's tenant. The handler:
 *
 *   1. Pre-validates the site exists in the caller's tenant.
 *   2. Pre-validates AT MOST ONE incoming contact has
 *      `isPrimary=true`. The DB has a partial unique index on
 *      `(siteId) WHERE isPrimary=true` that would catch this on
 *      INSERT, but failing fast at the handler gives a clearer
 *      error message and avoids spending a transaction round-trip.
 *   3. Snapshots the previous contact rows (for the outbox event's
 *      `previousContacts` payload).
 *   4. Deletes existing rows for `(tenantId, siteId)`.
 *   5. Inserts the new rows.
 *   6. Enqueues `SiteContactsChanged` outbox event in the same
 *      QueryRunner transaction so the event never fires without the
 *      domain writes, and the domain never commits without its
 *      event enqueued.
 *   7. Commits.
 *
 * Returns the post-write set of `SiteContact` rows.
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import {
  createBaseEvent,
  type SiteContactsChangedEvent,
} from '@platform/event-contracts';

import { UpsertSiteContactsCommand } from '../commands/upsert-site-contacts.command';
import { Site } from '../entities/site.entity';
import { SiteContact } from '../entities/site-contact.entity';

@CommandHandler(UpsertSiteContactsCommand)
export class UpsertSiteContactsHandler
  implements ICommandHandler<UpsertSiteContactsCommand, SiteContact[]>
{
  private readonly logger = new Logger(UpsertSiteContactsHandler.name);

  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectRepository(SiteContact)
    private readonly siteContactRepository: Repository<SiteContact>,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpsertSiteContactsCommand): Promise<SiteContact[]> {
    const { siteId, contacts, tenantId, userId } = command;

    this.logger.log(
      `Upserting ${contacts.length} contact(s) for site ${siteId}`,
    );

    // 1. Site exists in tenant.
    const site = await this.siteRepository.findOne({
      where: { id: siteId, tenantId },
    });
    if (!site) {
      throw new NotFoundException(`Site ${siteId} not found in tenant.`);
    }

    // 2. At most one isPrimary=true entry.
    const primaryCount = contacts.filter((c) => c.isPrimary === true).length;
    if (primaryCount > 1) {
      throw new BadRequestException(
        `At most one contact may be marked isPrimary; got ${primaryCount}.`,
      );
    }

    // 3. Snapshot previous state for the outbox event.
    const previousRows = await this.siteContactRepository.find({
      where: { tenantId, siteId },
      order: { isPrimary: 'DESC', createdAt: 'ASC' },
    });
    const previousContactsForEvent = previousRows.map((r) => ({
      name: r.name,
      role: r.role ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      isPrimary: r.isPrimary,
    }));

    // 4..6 transactional swap + outbox.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.manager.delete(SiteContact, { tenantId, siteId });

      const newRows: SiteContact[] = contacts.map((c) => {
        const row = new SiteContact();
        row.tenantId = tenantId;
        row.siteId = siteId;
        row.name = c.name;
        row.role = c.role;
        row.email = c.email;
        row.phone = c.phone;
        row.isPrimary = c.isPrimary === true;
        row.createdBy = userId;
        return row;
      });
      const saved =
        newRows.length > 0
          ? await queryRunner.manager.save(SiteContact, newRows)
          : [];

      const newContactsForEvent = saved.map((r) => ({
        name: r.name,
        role: r.role ?? null,
        email: r.email ?? null,
        phone: r.phone ?? null,
        isPrimary: r.isPrimary,
      }));

      const event: SiteContactsChangedEvent = {
        ...createBaseEvent<SiteContactsChangedEvent>(
          'SiteContactsChanged',
          tenantId,
          { aggregateId: siteId, aggregateType: 'Site' },
        ),
        siteId,
        previousContacts: previousContactsForEvent,
        newContacts: newContactsForEvent,
        changedBy: userId,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);

      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
