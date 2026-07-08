import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus } from '@platform/cqrs';
import { CurrentTenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { WorkerResponse } from './dto/worker.response';
import { CreateWorkerInput } from './dto/create-worker.input';
import { UpdateWorkerInput } from './dto/update-worker.input';
import { CreateWorkerCommand } from './commands/create-worker.command';
import { UpdateWorkerCommand } from './commands/update-worker.command';
import { DeleteWorkerCommand } from './commands/delete-worker.command';
import { ListWorkersQuery } from './queries/list-workers.query';
import { Worker } from './entities/worker.entity';

@Resolver(() => WorkerResponse)
@UseGuards(TenantGuard)
export class WorkerResolver {
  private readonly logger = new Logger(WorkerResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => [WorkerResponse])
  async workers(
    @CurrentTenant() tenantId: string,
  ): Promise<WorkerResponse[]> {
    const workers = await this.queryBus.execute(new ListWorkersQuery(tenantId)) as Array<Record<string, unknown>>;
    return workers.map((w: any) => ({
      id: w.id,
      employeeNumber: w.employeeNumber,
      firstName: w.firstName,
      lastName: w.lastName,
      email: w.email,
      phone: w.contactInfo?.phone || undefined,
      department: w.department,
      position: w.position,
      isVeterinarian: w.isVeterinarian ?? false,
      veterinaryLicenseNumber: w.veterinaryLicenseNumber ?? undefined,
      status: w.status,
      hireDate: w.hireDate,
      createdAt: w.createdAt,
    }));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => WorkerResponse)
  async createWorker(
    @Args('input') input: CreateWorkerInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WorkerResponse> {
    this.logger.log(`Creating worker for tenant ${tenantId}`);
    const command = new CreateWorkerCommand(input, tenantId, user.sub);
    const worker = await this.commandBus.execute(command) as Worker;
    return {
      id: worker.id,
      employeeNumber: worker.employeeNumber,
      firstName: worker.firstName,
      lastName: worker.lastName,
      email: worker.email,
      phone: worker.contactInfo?.phone || undefined,
      department: worker.department,
      position: worker.position,
      isVeterinarian: worker.isVeterinarian ?? false,
      veterinaryLicenseNumber: worker.veterinaryLicenseNumber ?? undefined,
      status: worker.status,
      hireDate: worker.hireDate,
      createdAt: worker.createdAt,
    };
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => WorkerResponse)
  async updateWorker(
    @Args('input') input: UpdateWorkerInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WorkerResponse> {
    this.logger.log(`Updating worker ${input.id} for tenant ${tenantId}`);
    const command = new UpdateWorkerCommand(input, tenantId, user.sub);
    const worker = await this.commandBus.execute(command) as Worker;
    return {
      id: worker.id,
      employeeNumber: worker.employeeNumber,
      firstName: worker.firstName,
      lastName: worker.lastName,
      email: worker.email,
      phone: worker.contactInfo?.phone || undefined,
      department: worker.department,
      position: worker.position,
      isVeterinarian: worker.isVeterinarian ?? false,
      veterinaryLicenseNumber: worker.veterinaryLicenseNumber ?? undefined,
      status: worker.status,
      hireDate: worker.hireDate,
      createdAt: worker.createdAt,
    };
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteWorker(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    this.logger.log(`Deleting worker ${id} for tenant ${tenantId}`);
    const command = new DeleteWorkerCommand(id, tenantId, user.sub);
    return this.commandBus.execute(command);
  }
}
