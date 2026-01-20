import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { CertificationType } from './entities/certification-type.entity';
import { EmployeeCertification } from './entities/employee-certification.entity';
import { TrainingCourse } from './entities/training-course.entity';
import { TrainingEnrollment } from './entities/training-enrollment.entity';
import { TrainingResolver } from './training.resolver';
import { TrainingCommandHandlers } from './handlers';
import { TrainingQueryHandlers } from './query-handlers';
import { Employee } from '../hr/entities/employee.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CertificationType,
      EmployeeCertification,
      TrainingCourse,
      TrainingEnrollment,
      Employee,
    ]),
    CqrsModule,
  ],
  providers: [
    TrainingResolver,
    ...TrainingCommandHandlers,
    ...TrainingQueryHandlers,
  ],
  exports: [TypeOrmModule],
})
export class TrainingModule {}
