/**
 * Equipment Module
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { Equipment } from './entities/equipment.entity';
import { EquipmentType } from './entities/equipment-type.entity';
import { EquipmentSystem } from './entities/equipment-system.entity';
import { SubEquipment } from './entities/sub-equipment.entity';
import { SubEquipmentType } from './entities/sub-equipment-type.entity';
import { FeederCalibration } from './entities/feeder-calibration.entity';
import { Department } from '../department/entities/department.entity';
import { System } from '../system/entities/system.entity';
import { SubSystem } from '../system/entities/sub-system.entity';
import { Supplier } from '../supplier/entities/supplier.entity';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { BatchFeedAssignment } from '../batch/entities/batch-feed-assignment.entity';
import { Feed } from '../feed/entities/feed.entity';
import { Tank } from '../tank/entities/tank.entity';

// Modules
import { FeedingModule } from '../feeding/feeding.module';

// Services
import { EquipmentTypeLookupService } from './services/equipment-type-lookup.service';

// Resolvers
import { EquipmentResolver } from './equipment.resolver';
import { SubEquipmentResolver } from './sub-equipment.resolver';

// Equipment Command Handlers
import { CreateEquipmentHandler } from './handlers/create-equipment.handler';
import { UpdateEquipmentHandler } from './handlers/update-equipment.handler';
import { DeleteEquipmentHandler } from './handlers/delete-equipment.handler';
import { SaveFeederCalibrationsHandler } from './handlers/save-feeder-calibrations.handler';

// Equipment Query Handlers
import { GetEquipmentHandler } from './handlers/get-equipment.handler';
import { ListEquipmentHandler } from './handlers/list-equipment.handler';
import { GetEquipmentTypesHandler } from './handlers/get-equipment-types.handler';
import { GetEquipmentDeletePreviewHandler } from './handlers/get-equipment-delete-preview.handler';
import { ListFeederCalibrationsHandler } from './handlers/list-feeder-calibrations.handler';

// SubEquipment Command Handlers
import { CreateSubEquipmentHandler } from './handlers/create-sub-equipment.handler';
import { UpdateSubEquipmentHandler } from './handlers/update-sub-equipment.handler';
import { DeleteSubEquipmentHandler } from './handlers/delete-sub-equipment.handler';

// SubEquipment Query Handlers
import { GetSubEquipmentHandler } from './handlers/get-sub-equipment.handler';
import { ListSubEquipmentHandler } from './handlers/list-sub-equipment.handler';
import { GetSubEquipmentTypesHandler } from './handlers/get-sub-equipment-types.handler';

const CommandHandlers = [
  CreateEquipmentHandler,
  UpdateEquipmentHandler,
  DeleteEquipmentHandler,
  SaveFeederCalibrationsHandler,
  CreateSubEquipmentHandler,
  UpdateSubEquipmentHandler,
  DeleteSubEquipmentHandler,
];

const QueryHandlers = [
  GetEquipmentHandler,
  ListEquipmentHandler,
  GetEquipmentTypesHandler,
  GetEquipmentDeletePreviewHandler,
  ListFeederCalibrationsHandler,
  GetSubEquipmentHandler,
  ListSubEquipmentHandler,
  GetSubEquipmentTypesHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Equipment,
      EquipmentType,
      EquipmentSystem,
      SubEquipment,
      SubEquipmentType,
      FeederCalibration,
      Department,
      System,
      SubSystem,
      Supplier,
      TankBatch,
      BatchFeedAssignment,
      Feed,
      Tank, // Added for unified equipmentList query
    ]),
    FeedingModule,
  ],
  providers: [
    EquipmentResolver,
    SubEquipmentResolver,
    EquipmentTypeLookupService,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
    EquipmentTypeLookupService,
  ],
})
export class EquipmentModule {}
