import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@platform/cqrs';

import { Worker } from './entities/worker.entity';
import { WorkerResolver } from './worker.resolver';

import { CreateWorkerHandler } from './handlers/create-worker.handler';
import { UpdateWorkerHandler } from './handlers/update-worker.handler';
import { DeleteWorkerHandler } from './handlers/delete-worker.handler';
import { ListWorkersHandler } from './handlers/list-workers.handler';

const CommandHandlers = [
  CreateWorkerHandler,
  UpdateWorkerHandler,
  DeleteWorkerHandler,
];

const QueryHandlers = [
  ListWorkersHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Worker]),
    CqrsModule,
  ],
  providers: [
    WorkerResolver,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class WorkerModule {}
