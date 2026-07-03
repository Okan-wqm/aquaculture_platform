import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { CertificationType } from './entities/certification-type.entity';
import { EmployeeCertification } from './entities/employee-certification.entity';
import { TrainingCourse } from './entities/training-course.entity';
import { TrainingEnrollment } from './entities/training-enrollment.entity';
import { TrainingSession } from './entities/training-session.entity';
import { TrainingResolver } from './training.resolver';
import { TrainingCommandHandlers } from './handlers';
import { TrainingQueryHandlers } from './query-handlers';
import { CertificationExpiryService } from './certification-expiry.service';
import { Employee } from '../hr/entities/employee.entity';
import { WorkArea } from '../aquaculture/entities/work-area.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CertificationType,
      EmployeeCertification,
      TrainingCourse,
      TrainingEnrollment,
      TrainingSession,
      Employee,
      // WorkArea is owned by AquacultureModule; registered here read-only so
      // GetCertificationsForWorkArea can resolve a work area's required certs.
      WorkArea,
    ]),
    CqrsModule,
    ScheduleModule,
  ],
  providers: [
    TrainingResolver,
    ...TrainingCommandHandlers,
    ...TrainingQueryHandlers,
    CertificationExpiryService,
  ],
  exports: [TypeOrmModule],
})
export class TrainingModule {}
