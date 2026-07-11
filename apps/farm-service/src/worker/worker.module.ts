import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Worker } from './entities/worker.entity';
import { WorkerResolver } from './worker.resolver';
// FinanceModule exports the currency SSoT resolver (FARM-HIGH-151).
import { FinanceModule } from '../finance/finance.module';

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
    FinanceModule,
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
