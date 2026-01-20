import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetLeaveRequestByIdQuery } from '../queries/get-leave-request-by-id.query';
import { LeaveRequest } from '../entities/leave-request.entity';

@QueryHandler(GetLeaveRequestByIdQuery)
export class GetLeaveRequestByIdHandler implements IQueryHandler<GetLeaveRequestByIdQuery> {
  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
  ) {}

  async execute(query: GetLeaveRequestByIdQuery): Promise<LeaveRequest> {
    const { tenantId, leaveRequestId } = query;

    const leaveRequest = await this.leaveRequestRepository.findOne({
      where: { id: leaveRequestId, tenantId, isDeleted: false },
      relations: ['employee', 'leaveType'],
    });

    if (!leaveRequest) {
      throw new NotFoundException(`Leave request with ID ${leaveRequestId} not found`);
    }

    return leaveRequest;
  }
}
