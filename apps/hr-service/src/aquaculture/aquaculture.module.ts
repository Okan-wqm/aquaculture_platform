import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { WorkArea } from './entities/work-area.entity';
import { Employee } from '../hr/entities/employee.entity';
import { WorkRotation } from './entities/work-rotation.entity';
import { SafetyTrainingRecord } from './entities/safety-training-record.entity';
import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { EmployeeCertification } from '../training/entities/employee-certification.entity';
import { CertificationType } from '../training/entities/certification-type.entity';
import { AquacultureResolver } from './aquaculture.resolver';
import { AquacultureQueryHandlers } from './query-handlers';
import { AquacultureCommandHandlers } from './handlers';
import { CertificationValidationService } from './certification-validation.service';
import { HRModule } from '../hr/hr.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WorkArea,
      WorkRotation,
      SafetyTrainingRecord,
      AttendanceRecord,
      Employee,
      EmployeeCertification,
      CertificationType,
    ]),
    HRModule,
    CqrsModule,
  ],
  providers: [
    AquacultureResolver,
    ...AquacultureQueryHandlers,
    ...AquacultureCommandHandlers,
    CertificationValidationService,
  ],
  exports: [TypeOrmModule, CertificationValidationService],
})
export class AquacultureModule {}
