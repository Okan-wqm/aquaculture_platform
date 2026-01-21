import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EdgeDeviceModule } from '../edge-device/edge-device.module';
import { IngestionModule } from '../ingestion/ingestion.module';

import { AutomationResolver, ProgramStepResolver } from './automation.resolver';
import { AutomationService } from './automation.service';
import {
  AutomationProgram,
  ProgramStep,
  StepAction,
  ProgramTransition,
  ProgramVariable,
} from './entities';

/**
 * Automation Module
 *
 * Provides IEC 61131-3 compliant automation programming capabilities:
 * - Sequential Function Chart (SFC) programs
 * - Structured Text (ST) actions
 * - Program lifecycle management (draft → review → approved → deployed)
 * - Variable binding to sensors and equipment
 *
 * v2.1 Features:
 * - Deploy programs to edge devices via MQTT
 * - Translate IEC 61131-3 to edge script format
 * - Rollback support
 *
 * Integration points:
 * - EdgeDevice module: Programs are deployed to edge devices
 * - Process module: Variables bind to equipment nodes in process templates
 * - Sensor module: Variables can map to sensor data channels
 * - Ingestion module: MQTT communication for deployment
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AutomationProgram,
      ProgramStep,
      StepAction,
      ProgramTransition,
      ProgramVariable,
    ]),
    forwardRef(() => EdgeDeviceModule),
    forwardRef(() => IngestionModule),
  ],
  providers: [
    AutomationService,
    AutomationResolver,
    ProgramStepResolver,
  ],
  exports: [AutomationService],
})
export class AutomationModule {}
