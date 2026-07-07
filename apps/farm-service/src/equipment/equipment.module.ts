/**
 * Equipment Module
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { BatchFeedAssignment } from '../batch/entities/batch-feed-assignment.entity';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { Department } from '../department/entities/department.entity';
import { FarmStockModule } from '../farm-stock/farm-stock.module';
import { Feed } from '../feed/entities/feed.entity';
import { FeedingModule } from '../feeding/feeding.module';
// FinanceModule exports the currency SSoT resolver (FARM-HIGH-146).
import { FinanceModule } from '../finance/finance.module';
import { Supplier } from '../supplier/entities/supplier.entity';
import { SubSystem } from '../system/entities/sub-system.entity';
import { System } from '../system/entities/system.entity';
import { Tank } from '../tank/entities/tank.entity';

import { EquipmentSystem } from './entities/equipment-system.entity';
import { EquipmentType } from './entities/equipment-type.entity';
import { Equipment } from './entities/equipment.entity';
import { FeederCalibration } from './entities/feeder-calibration.entity';
import { SubEquipmentType } from './entities/sub-equipment-type.entity';
import { SubEquipment } from './entities/sub-equipment.entity';
import { EquipmentResolver } from './equipment.resolver';
import { CreateEquipmentHandler } from './handlers/create-equipment.handler';
import { CreateSubEquipmentHandler } from './handlers/create-sub-equipment.handler';
import { DeleteEquipmentHandler } from './handlers/delete-equipment.handler';
import { DeleteSubEquipmentHandler } from './handlers/delete-sub-equipment.handler';
import { GetEquipmentDeletePreviewHandler } from './handlers/get-equipment-delete-preview.handler';
import { GetEquipmentTypesHandler } from './handlers/get-equipment-types.handler';
import { GetEquipmentHandler } from './handlers/get-equipment.handler';
import { GetSubEquipmentTypesHandler } from './handlers/get-sub-equipment-types.handler';
import { GetSubEquipmentHandler } from './handlers/get-sub-equipment.handler';
import { ListEquipmentHandler } from './handlers/list-equipment.handler';
import { ListFeederCalibrationsHandler } from './handlers/list-feeder-calibrations.handler';
import { ListSubEquipmentHandler } from './handlers/list-sub-equipment.handler';
import { SaveFeederCalibrationsHandler } from './handlers/save-feeder-calibrations.handler';
import { UpdateEquipmentHandler } from './handlers/update-equipment.handler';
import { UpdateSubEquipmentHandler } from './handlers/update-sub-equipment.handler';
import { EquipmentTypeCatalogCheckerService } from './services/equipment-type-catalog-checker.service';
import { EquipmentTypeLookupService } from './services/equipment-type-lookup.service';
import { TankEquipmentAdapterService } from './services/tank-equipment-adapter.service';
import { SubEquipmentResolver } from './sub-equipment.resolver';
import { WaterTemperatureService } from '../water-quality/services/water-temperature.service';

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
    FarmStockModule,
    FinanceModule,
  ],
  providers: [
    EquipmentResolver,
    SubEquipmentResolver,
    TankEquipmentAdapterService,
    EquipmentTypeLookupService,
    EquipmentTypeCatalogCheckerService,
    WaterTemperatureService,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
    TankEquipmentAdapterService,
    EquipmentTypeLookupService,
    EquipmentTypeCatalogCheckerService,
  ],
})
export class EquipmentModule {}
