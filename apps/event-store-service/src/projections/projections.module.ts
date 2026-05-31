import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ProjectionCheckpoint } from './entities/projection-checkpoint.entity';
import { ProjectionInbox } from './entities/projection-inbox.entity';
import { StoredEvent } from '../event-store/entities/stored-event.entity';
import { ProjectionsService } from './projections.service';
import { ProjectionsController } from './projections.controller';

@Module({
  imports: [
    ScheduleModule,
    TypeOrmModule.forFeature([ProjectionCheckpoint, ProjectionInbox, StoredEvent]),
  ],
  controllers: [ProjectionsController],
  providers: [ProjectionsService],
  exports: [ProjectionsService],
})
export class ProjectionsModule {}
