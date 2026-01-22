/**
 * Equipment Module
 */
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';

// Entities
import { Equipment } from './entities/equipment.entity';
import { EquipmentType } from './entities/equipment-type.entity';
import { EquipmentSystem } from './entities/equipment-system.entity';
import { SubEquipment } from './entities/sub-equipment.entity';
import { SubEquipmentType } from './entities/sub-equipment-type.entity';
import { Department } from '../department/entities/department.entity';
import { System } from '../system/entities/system.entity';
import { SubSystem } from '../system/entities/sub-system.entity';
import { Supplier } from '../supplier/entities/supplier.entity';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { BatchFeedAssignment } from '../batch/entities/batch-feed-assignment.entity';
import { Feed } from '../feed/entities/feed.entity';

// Modules
import { FeedingModule } from '../feeding/feeding.module';

// Resolver
import { EquipmentResolver } from './equipment.resolver';

// Command Handlers
import { CreateEquipmentHandler } from './handlers/create-equipment.handler';
import { UpdateEquipmentHandler } from './handlers/update-equipment.handler';
import { DeleteEquipmentHandler } from './handlers/delete-equipment.handler';

// Query Handlers
import { GetEquipmentHandler } from './handlers/get-equipment.handler';
import { ListEquipmentHandler } from './handlers/list-equipment.handler';
import { GetEquipmentTypesHandler } from './handlers/get-equipment-types.handler';
import { GetEquipmentDeletePreviewHandler } from './handlers/get-equipment-delete-preview.handler';

const CommandHandlers = [
  CreateEquipmentHandler,
  UpdateEquipmentHandler,
  DeleteEquipmentHandler,
];

const QueryHandlers = [
  GetEquipmentHandler,
  ListEquipmentHandler,
  GetEquipmentTypesHandler,
  GetEquipmentDeletePreviewHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Equipment,
      EquipmentType,
      EquipmentSystem,
      SubEquipment,
      SubEquipmentType,
      Department,
      System,
      SubSystem,
      Supplier,
      TankBatch,
      BatchFeedAssignment,
      Feed,
    ]),
    CqrsModule,
    forwardRef(() => FeedingModule),
  ],
  providers: [
    EquipmentResolver,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class EquipmentModule {}
