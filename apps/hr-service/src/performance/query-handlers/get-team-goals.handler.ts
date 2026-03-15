import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetTeamGoalsQuery } from '../queries/get-team-goals.query';
import { Goal } from '../entities/goal.entity';
import { Employee } from '../../hr/entities/employee.entity';

@QueryHandler(GetTeamGoalsQuery)
export class GetTeamGoalsHandler implements IQueryHandler<GetTeamGoalsQuery> {
  constructor(
    @InjectRepository(Goal)
    private readonly goalRepository: Repository<Goal>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetTeamGoalsQuery): Promise<Goal[]> {
    const { tenantId, managerId, status } = query;

    // Find all employees supervised by this manager
    const teamMembers = await this.employeeRepository.find({
      where: { tenantId, supervisorId: managerId, isDeleted: false },
      select: ['id'],
    });

    if (teamMembers.length === 0) {
      return [];
    }

    const teamMemberIds = teamMembers.map((e) => e.id);

    const qb = this.goalRepository
      .createQueryBuilder('g')
      .leftJoinAndSelect('g.employee', 'employee')
      .where('g.tenantId = :tenantId', { tenantId })
      .andWhere('g.employeeId IN (:...teamMemberIds)', { teamMemberIds })
      .andWhere('g.isDeleted = false')
      .orderBy('g.targetDate', 'ASC');

    if (status) {
      qb.andWhere('g.status = :status', { status });
    }

    return qb.getMany();
  }
}
