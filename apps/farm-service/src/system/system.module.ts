/**
 * System Module
 * Manages System and SubSystem entities
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@platform/cqrs';
import { System } from './entities/system.entity';
import { SubSystem } from './entities/sub-system.entity';
import { Site } from '../site/entities/site.entity';
import { Department } from '../department/entities/department.entity';
import { Equipment } from '../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../equipment/entities/equipment-system.entity';
import { SystemResolver } from './system.resolver';
import { SystemHandlers } from './handlers';

@Module({
  imports: [
    // Note: Site and Department entities are registered here for repository access
    // No need to import SiteModule/DepartmentModule - they only export TypeOrmModule
    TypeOrmModule.forFeature([System, SubSystem, Site, Department, Equipment, EquipmentSystem]),
    CqrsModule,
  ],
  providers: [
    SystemResolver,
    ...SystemHandlers,
  ],
  exports: [TypeOrmModule],
})
export class SystemModule {}
