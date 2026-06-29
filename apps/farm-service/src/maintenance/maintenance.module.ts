/**
 * Maintenance Module
 *
 * Bakım ve iş emri yönetimi.
 * Önleyici ve düzeltici bakım planlaması.
 *
 * Sağladığı özellikler:
 * - İş emri oluşturma ve takip
 * - Önleyici bakım planları
 * - Tekrarlayan bakım zamanlaması
 * - Maliyet ve işçilik takibi
 * - Otomatik iş emri oluşturma
 * - Yedek parça stok yönetimi
 *
 * @module Maintenance
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { WorkOrder } from './entities/work-order.entity';
import { MaintenanceSchedule } from './entities/maintenance-schedule.entity';
import { SparePart } from './entities/spare-part.entity';

// Services
import { WorkOrderService } from './services/work-order.service';
import { MaintenanceScheduleService } from './services/maintenance-schedule.service';
import { SparePartService } from './services/spare-part.service';

// Resolvers
import { WorkOrderResolver } from './resolvers/work-order.resolver';
import { MaintenanceScheduleResolver } from './resolvers/maintenance-schedule.resolver';
import { SparePartResolver } from './resolvers/spare-part.resolver';

// Spare-part read handlers (fail-closed tenant boundary — FARM-HIGH-060)
import { GetSparePartHandler } from './handlers/get-spare-part.handler';
import { GetSparePartByCodeHandler } from './handlers/get-spare-part-by-code.handler';
import { GetSparePartByPartNumberHandler } from './handlers/get-spare-part-by-part-number.handler';
import { ListSparePartsHandler } from './handlers/list-spare-parts.handler';
import { ListLowStockAlertsHandler } from './handlers/list-low-stock-alerts.handler';
import { ListSparePartsByEquipmentTypeHandler } from './handlers/list-spare-parts-by-equipment-type.handler';
import { GetStockSummaryHandler } from './handlers/get-stock-summary.handler';

const SparePartQueryHandlers = [
  GetSparePartHandler,
  GetSparePartByCodeHandler,
  GetSparePartByPartNumberHandler,
  ListSparePartsHandler,
  ListLowStockAlertsHandler,
  ListSparePartsByEquipmentTypeHandler,
  GetStockSummaryHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkOrder,
      MaintenanceSchedule,
      SparePart,
    ]),
  ],
  providers: [
    // Services
    WorkOrderService,
    MaintenanceScheduleService,
    SparePartService,

    // Resolvers
    WorkOrderResolver,
    MaintenanceScheduleResolver,
    SparePartResolver,

    // Spare-part query handlers
    ...SparePartQueryHandlers,
  ],
  exports: [
    TypeOrmModule,
    WorkOrderService,
    MaintenanceScheduleService,
    SparePartService,
  ],
})
export class MaintenanceModule {}
