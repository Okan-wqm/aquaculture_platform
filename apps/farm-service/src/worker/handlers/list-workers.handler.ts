import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListWorkersQuery } from '../queries/list-workers.query';
import { Worker } from '../entities/worker.entity';

@QueryHandler(ListWorkersQuery)
export class ListWorkersHandler implements IQueryHandler<ListWorkersQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: ListWorkersQuery): Promise<Worker[]> {
    const { tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const workers = await queryRunner.manager.find(Worker, {
        where: { tenantId, isDeleted: false },
      });

      // SECURITY (pii-at-rest): firstName/lastName are AES-256-GCM ciphertext at
      // rest with a fresh IV per write, so a DB `ORDER BY firstName, lastName`
      // sorts ciphertext — effectively random output. The column transformer
      // decrypts these on read, so the only place a correct alphabetical order
      // can be produced is the application layer, over the decrypted plaintext.
      // localeCompare gives locale-aware ordering (accents, case) rather than the
      // raw UTF-16 code-unit order of a bare `<`/`>` comparison.
      return workers.sort((a, b) => {
        const byFirst = a.firstName.localeCompare(b.firstName);
        return byFirst !== 0 ? byFirst : a.lastName.localeCompare(b.lastName);
      });
    });
  }
}
