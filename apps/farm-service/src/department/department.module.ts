/**
 * Department Module
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';

// Entities
import { Department } from './entities/department.entity';
import { Site } from '../site/entities/site.entity';
import { Equipment } from '../equipment/entities/equipment.entity';
import { Tank } from '../tank/entities/tank.entity';
import { System } from '../system/entities/system.entity';

// Resolver
import { DepartmentResolver } from './department.resolver';

// Command Handlers
import { CreateDepartmentHandler } from './handlers/create-department.handler';
import { UpdateDepartmentHandler } from './handlers/update-department.handler';
import { DeleteDepartmentHandler } from './handlers/delete-department.handler';

// Query Handlers
import { GetDepartmentHandler } from './handlers/get-department.handler';
import { ListDepartmentsHandler } from './handlers/list-departments.handler';
import { GetDepartmentDeletePreviewHandler } from './handlers/get-department-delete-preview.handler';

const CommandHandlers = [
  CreateDepartmentHandler,
  UpdateDepartmentHandler,
  DeleteDepartmentHandler,
];

const QueryHandlers = [
  GetDepartmentHandler,
  ListDepartmentsHandler,
  GetDepartmentDeletePreviewHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Department, Site, Equipment, Tank, System]),
    CqrsModule,
  ],
  providers: [
    DepartmentResolver,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class DepartmentModule {}
