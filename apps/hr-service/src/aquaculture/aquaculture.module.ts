import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { WorkArea } from './entities/work-area.entity';
import { Employee } from '../hr/entities/employee.entity';
import { WorkRotation } from './entities/work-rotation.entity';
import { SafetyTrainingRecord } from './entities/safety-training-record.entity';
import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { AquacultureResolver } from './aquaculture.resolver';
import { AquacultureQueryHandlers } from './query-handlers';
import { AquacultureCommandHandlers } from './handlers';
import { HRModule } from '../hr/hr.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkArea,
      WorkRotation,
      SafetyTrainingRecord,
      AttendanceRecord,
      Employee,
    ]),
    HRModule,
    CqrsModule,
  ],
  providers: [
    AquacultureResolver,
    ...AquacultureQueryHandlers,
    ...AquacultureCommandHandlers,
  ],
  exports: [TypeOrmModule],
})
export class AquacultureModule {}
