/**
 * Ünite → yemleyici atama okuma yolu.
 *
 * WHY it exists as its own query: the next phase (meal generation and the mobile
 * feeding board) needs "given a unit, its active feeders and their shares" as a
 * first-class read, not as a join it has to reinvent. `includeEnded` serves the
 * traceability direction — which feeder held which share when a past record was
 * written.
 *
 * @module FeedingProtocol/QueryHandlers
 */
import { IQueryHandler, QueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';

import { FeederAssignment, FeederAssignmentStatus } from '../entities/feeder-assignment.entity';
import { GetUnitFeederAssignmentsQuery } from '../queries/feeder-assignment.queries';

@QueryHandler(GetUnitFeederAssignmentsQuery)
export class GetUnitFeederAssignmentsHandler
  implements IQueryHandler<GetUnitFeederAssignmentsQuery, FeederAssignment[]>
{
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(query: GetUnitFeederAssignmentsQuery): Promise<FeederAssignment[]> {
    const { tenantId, unitId, includeEnded } = query;

    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const repository = tenantManagerRepo(queryRunner.manager, FeederAssignment, tenantId);
      return repository.find({
        where: includeEnded
          ? { tenantId, unitId }
          : { tenantId, unitId, status: FeederAssignmentStatus.ACTIVE },
        // Aktif satırlar payı büyükten küçüğe; tarihçe istendiğinde en yeni kuşak
        // üstte kalsın diye ikincil sıralama oluşturulma zamanına göre azalan.
        order: { status: 'ASC', doseSharePercent: 'DESC', createdAt: 'DESC' },
      });
    });
  }
}
