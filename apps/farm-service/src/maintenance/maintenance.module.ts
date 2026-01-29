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
import { CqrsModule } from '@platform/cqrs';

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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkOrder,
      MaintenanceSchedule,
      SparePart,
    ]),
    CqrsModule,
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
  ],
  exports: [
    TypeOrmModule,
    WorkOrderService,
    MaintenanceScheduleService,
    SparePartService,
  ],
})
export class MaintenanceModule {}
