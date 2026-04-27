import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MigrationEventEntity } from '../../database/entities/migration-event.entity';

/**
 * Thin TypeORM wrapper — surfaces only the operations the migration-audit
 * handler needs. Keeps the handler free of raw ORM knowledge so unit
 * tests can mock a Repository<MigrationEventEntity> cleanly.
 */
@Injectable()
export class MigrationEventRepository {
  constructor(
    @InjectRepository(MigrationEventEntity)
    private readonly repo: Repository<MigrationEventEntity>,
  ) {}

  async insert(event: Omit<MigrationEventEntity, 'id'>): Promise<MigrationEventEntity> {
    const saved = await this.repo.save(this.repo.create(event));
    return saved;
  }

  async recent(
    serviceName: string,
    environment: string,
    limit: number,
  ): Promise<MigrationEventEntity[]> {
    return this.repo.find({
      where: { serviceName, environment },
      order: { occurredAt: 'DESC' },
      take: Math.min(Math.max(1, limit), 1000),
    });
  }
}
