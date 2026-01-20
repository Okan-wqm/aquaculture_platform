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
 *
 * @module Maintenance
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@platform/cqrs';

// Entities
import { WorkOrder } from './entities/work-order.entity';
import { MaintenanceSchedule } from './entities/maintenance-schedule.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkOrder,
      MaintenanceSchedule,
    ]),
    CqrsModule,
  ],
  providers: [
    // WorkOrderService,
    // MaintenanceScheduleService,
    // Handlers will be added
    // Resolvers will be added
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class MaintenanceModule {}
