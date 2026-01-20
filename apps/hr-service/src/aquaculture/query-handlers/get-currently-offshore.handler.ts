import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetCurrentlyOffshoreQuery } from '../queries/get-currently-offshore.query';
import { WorkRotation, RotationStatus, RotationType } from '../entities/work-rotation.entity';
import { Employee } from '../../hr/entities/employee.entity';

@QueryHandler(GetCurrentlyOffshoreQuery)
export class GetCurrentlyOffshoreHandler implements IQueryHandler<GetCurrentlyOffshoreQuery> {
  constructor(
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
  ) {}

  async execute(query: GetCurrentlyOffshoreQuery): Promise<Employee[]> {
    const { tenantId, workAreaId } = query;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const queryBuilder = this.rotationRepository
      .createQueryBuilder('wr')
      .leftJoinAndSelect('wr.employee', 'employee')
      .leftJoinAndSelect('wr.workArea', 'workArea')
      .where('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.status = :status', { status: RotationStatus.IN_PROGRESS })
      .andWhere('wr.rotationType = :rotationType', { rotationType: RotationType.OFFSHORE })
      .andWhere('wr.startDate <= :today', { today })
      .andWhere('wr.endDate >= :today', { today })
      .andWhere('wr.isDeleted = false');

    if (workAreaId) {
      queryBuilder.andWhere('wr.workAreaId = :workAreaId', { workAreaId });
    }

    const rotations = await queryBuilder.getMany();

    return rotations
      .filter((r) => r.employee)
      .map((r) => r.employee as Employee);
  }
}
