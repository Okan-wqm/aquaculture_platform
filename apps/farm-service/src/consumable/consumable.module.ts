/**
 * Consumable Module
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Consumable } from './entities/consumable.entity';
import { Supplier } from '../supplier/entities/supplier.entity';

import { ConsumableResolver } from './consumable.resolver';

import { RestoreModule } from '../common/services/restore.module';
// FinanceModule exports the currency SSoT resolver (FARM-HIGH-151).
import { FinanceModule } from '../finance/finance.module';

import { CreateConsumableHandler } from './handlers/create-consumable.handler';
import { UpdateConsumableHandler } from './handlers/update-consumable.handler';
import { DeleteConsumableHandler } from './handlers/delete-consumable.handler';

import { GetConsumableHandler } from './handlers/get-consumable.handler';
import { ListConsumablesHandler } from './handlers/list-consumables.handler';

const CommandHandlers = [
  CreateConsumableHandler,
  UpdateConsumableHandler,
  DeleteConsumableHandler,
];

const QueryHandlers = [
  GetConsumableHandler,
  ListConsumablesHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Consumable, Supplier]),
    RestoreModule,
    FinanceModule,
  ],
  providers: [
    ConsumableResolver,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class ConsumableModule {}
