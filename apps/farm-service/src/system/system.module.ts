/**
 * System Module
 * Manages System and SubSystem entities
 */
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { System } from './entities/system.entity';
import { SubSystem } from './entities/sub-system.entity';
import { Site } from '../site/entities/site.entity';
import { Department } from '../department/entities/department.entity';
import { Equipment } from '../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../equipment/entities/equipment-system.entity';
import { SystemResolver } from './system.resolver';
import { SystemHandlers } from './handlers';
import { SiteModule } from '../site/site.module';
import { DepartmentModule } from '../department/department.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([System, SubSystem, Site, Department, Equipment, EquipmentSystem]),
    CqrsModule,
    forwardRef(() => SiteModule),
    forwardRef(() => DepartmentModule),
  ],
  providers: [
    SystemResolver,
    ...SystemHandlers,
  ],
  exports: [TypeOrmModule],
})
export class SystemModule {}
