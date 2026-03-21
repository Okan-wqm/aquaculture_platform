import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetCrewAssignmentsQuery } from '../queries/get-crew-assignments.query';
import { WorkArea } from '../entities/work-area.entity';
import { WorkRotation, RotationStatus } from '../entities/work-rotation.entity';
import { CrewAssignment } from '../dto/crew-assignment.dto';

@QueryHandler(GetCrewAssignmentsQuery)
export class GetCrewAssignmentsHandler implements IQueryHandler<GetCrewAssignmentsQuery> {
  constructor(
    @InjectRepository(WorkArea)
    private readonly workAreaRepository: Repository<WorkArea>,
    @InjectRepository(WorkRotation)
    private readonly workRotationRepository: Repository<WorkRotation>,
  ) {}

  async execute(query: GetCrewAssignmentsQuery): Promise<CrewAssignment[]> {
    const { tenantId } = query;

    // Get all active work areas for the tenant
    const workAreas = await this.workAreaRepository.find({
      where: { tenantId, isActive: true, isDeleted: false },
      order: { displayOrder: 'ASC', name: 'ASC' },
    });

    // Get all active (in-progress) rotations for the tenant
    const activeRotations = await this.workRotationRepository.find({
      where: { tenantId, status: RotationStatus.IN_PROGRESS, isDeleted: false },
      select: ['workAreaId', 'employeeId'],
    });

    // Group rotations by work area
    const rotationsByArea = new Map<string, string[]>();
    for (const rotation of activeRotations) {
      const existing = rotationsByArea.get(rotation.workAreaId) || [];
      if (!existing.includes(rotation.employeeId)) {
        existing.push(rotation.employeeId);
      }
      rotationsByArea.set(rotation.workAreaId, existing);
    }

    // Build crew assignment for each work area
    return workAreas.map((area) => {
      const assignedEmployeeIds = rotationsByArea.get(area.id) || [];
      const currentCount = assignedEmployeeIds.length;
      const maxCapacity = area.maxCapacity || 0;
      const occupancyRate = maxCapacity > 0 ? (currentCount / maxCapacity) * 100 : 0;

      const assignment = new CrewAssignment();
      assignment.workAreaId = area.id;
      assignment.workAreaName = area.name;
      assignment.assignedEmployeeIds = assignedEmployeeIds;
      assignment.currentCount = currentCount;
      assignment.maxCapacity = maxCapacity;
      assignment.occupancyRate = Math.round(occupancyRate * 100) / 100;
      return assignment;
    });
  }
}
