import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { PerformanceReview } from './entities/performance-review.entity';
import { Goal } from './entities/goal.entity';
import { EmployeeKPI } from './entities/kpi.entity';
import { PerformanceResolver } from './performance.resolver';
import { PerformanceCommandHandlers } from './handlers';
import { PerformanceQueryHandlers } from './query-handlers';
import { Employee } from '../hr/entities/employee.entity';
import { DepartmentHR } from '../hr/entities/department.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PerformanceReview,
      Goal,
      EmployeeKPI,
      Employee,
      DepartmentHR,
    ]),
    CqrsModule,
  ],
  providers: [
    PerformanceResolver,
    ...PerformanceCommandHandlers,
    ...PerformanceQueryHandlers,
  ],
  exports: [TypeOrmModule],
})
export class PerformanceModule {}
