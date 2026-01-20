import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ProjectionCheckpoint } from './entities/projection-checkpoint.entity';
import { StoredEvent } from '../event-store/entities/stored-event.entity';
import { ProjectionsService } from './projections.service';
import { ProjectionsController } from './projections.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([ProjectionCheckpoint, StoredEvent]),
  ],
  controllers: [ProjectionsController],
  providers: [ProjectionsService],
  exports: [ProjectionsService],
})
export class ProjectionsModule {}
