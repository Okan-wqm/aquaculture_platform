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

// Work-order read handlers (fail-closed tenant boundary — FARM-HIGH-060)
import { GetWorkOrderHandler } from './handlers/get-work-order.handler';
import { GetWorkOrderByCodeHandler } from './handlers/get-work-order-by-code.handler';
import { ListWorkOrdersHandler } from './handlers/list-work-orders.handler';
import { ListOverdueWorkOrdersHandler } from './handlers/list-overdue-work-orders.handler';
import { ListMyWorkOrdersHandler } from './handlers/list-my-work-orders.handler';
import { GetWorkOrderStatisticsHandler } from './handlers/get-work-order-statistics.handler';

// Maintenance-schedule read handlers (fail-closed tenant boundary — FARM-HIGH-060)
import { GetMaintenanceScheduleHandler } from './handlers/get-maintenance-schedule.handler';
import { GetMaintenanceScheduleByCodeHandler } from './handlers/get-maintenance-schedule-by-code.handler';
import { ListMaintenanceSchedulesHandler } from './handlers/list-maintenance-schedules.handler';
import { ListUpcomingMaintenanceSchedulesHandler } from './handlers/list-upcoming-maintenance-schedules.handler';
import { ListOverdueMaintenanceSchedulesHandler } from './handlers/list-overdue-maintenance-schedules.handler';
import { ListMaintenanceScheduleAlertsHandler } from './handlers/list-maintenance-schedule-alerts.handler';
import { GetMaintenanceComplianceReportHandler } from './handlers/get-maintenance-compliance-report.handler';

const WorkOrderQueryHandlers = [
  GetWorkOrderHandler,
  GetWorkOrderByCodeHandler,
  ListWorkOrdersHandler,
  ListOverdueWorkOrdersHandler,
  ListMyWorkOrdersHandler,
  GetWorkOrderStatisticsHandler,
];

const MaintenanceScheduleQueryHandlers = [
  GetMaintenanceScheduleHandler,
  GetMaintenanceScheduleByCodeHandler,
  ListMaintenanceSchedulesHandler,
  ListUpcomingMaintenanceSchedulesHandler,
  ListOverdueMaintenanceSchedulesHandler,
  ListMaintenanceScheduleAlertsHandler,
  GetMaintenanceComplianceReportHandler,
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

    // Work-order query handlers
    ...WorkOrderQueryHandlers,

    // Maintenance-schedule query handlers
    ...MaintenanceScheduleQueryHandlers,
  ],
  exports: [
    TypeOrmModule,
    WorkOrderService,
    MaintenanceScheduleService,
    SparePartService,
  ],
})
export class MaintenanceModule {}
