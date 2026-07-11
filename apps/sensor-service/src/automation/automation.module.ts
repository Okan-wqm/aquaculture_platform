import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DeployArtifactModule } from '../deploy-artifact/deploy-artifact.module';
import { EdgeDeviceModule } from '../edge-device/edge-device.module';
// SharedMqttModule is @Global, provides MqttClientService

import { AutomationResolver, ProgramStepResolver } from './automation.resolver';
import { AutomationService } from './automation.service';
import { CompilerModule } from './compiler/compiler.module';
import {
  AutomationProgram,
  ProgramStep,
  StepAction,
  ProgramTransition,
  ProgramVariable,
} from './entities';
import { DeploymentLog } from './entities/deployment-log.entity';
import { DeploymentLogService } from './services/deployment-log.service';

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
 * v3.0 Features:
 * - ST Language Service (parser, IntelliSense, formatting)
 * - NATS request-reply handler for gateway-api WS bridge
 * - Automation event publishing (program saved/deployed, tags updated)
 *
 * Integration points:
 * - EdgeDevice module: Programs are deployed to edge devices
 * - Process module: Variables bind to equipment nodes in process templates
 * - Sensor module: Variables can map to sensor data channels
 * - SharedMqttModule: MQTT communication for deployment
 * - CompilerModule: ST language service, IntelliSense, NATS handlers
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AutomationProgram,
      ProgramStep,
      StepAction,
      ProgramTransition,
      ProgramVariable,
      DeploymentLog,
    ]),
    DeployArtifactModule, // Content-addressed deploy snapshots (Faz 3)
    EdgeDeviceModule, // For edge device service (no longer circular)
    CompilerModule, // ST language service, IntelliSense, NATS handlers
    // MqttClientService is available via @Global SharedMqttModule
  ],
  providers: [
    AutomationService,
    DeploymentLogService,
    AutomationResolver,
    ProgramStepResolver,
  ],
  exports: [AutomationService, DeploymentLogService],
})
 
export class AutomationModule {}
