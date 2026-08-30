import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SensorDataChannel } from '../database/entities/sensor-data-channel.entity';

import { CalibrationEvent } from './calibration-event.entity';
import { CalibrationRecordingService } from './calibration-recording.service';
import { CalibrationResolver } from './calibration.resolver';

/**
 * Calibration domain (SENSOR-HIGH-083): the aggregate that owns a channel's
 * calibration history and is the single write path for its coefficients.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CalibrationEvent, SensorDataChannel])],
  providers: [CalibrationRecordingService, CalibrationResolver],
  exports: [CalibrationRecordingService],
})
export class CalibrationModule {}
