import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { WorkArea } from './entities/work-area.entity';
import { WorkRotation } from './entities/work-rotation.entity';
import { SafetyTrainingRecord } from './entities/safety-training-record.entity';
import { AquacultureResolver } from './aquaculture.resolver';
import { AquacultureQueryHandlers } from './query-handlers';
import { Employee } from '../hr/entities/employee.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkArea,
      WorkRotation,
      SafetyTrainingRecord,
      Employee,
    ]),
    CqrsModule,
  ],
  providers: [
    AquacultureResolver,
    ...AquacultureQueryHandlers,
  ],
  exports: [TypeOrmModule],
})
export class AquacultureModule {}
