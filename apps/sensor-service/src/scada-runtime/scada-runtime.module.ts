/**
 * ScadaRuntimeModule
 *
 * NestJS module that wires together the SCADA HMI operator runtime:
 *  - ScadaRuntimeGateway  — Socket.IO WebSocket gateway (/scada namespace)
 *  - TagManagerService    — In-memory tag subscription + value cache
 *
 * External dependencies consumed (must be globally available):
 *  - JwtModule (registered as global in AppModule)
 *  - ConfigModule (registered as global in AppModule)
 *  - EventEmitterModule (registered in RegistrationModule; ensured here as well)
 *
 * The module exports TagManagerService so that device-driver adapters
 * (OPC UA, MQTT, Modbus, etc.) living in sibling modules can call
 * `tagManager.updateTagValues()` to push live data through the gateway,
 * and listen for the SCADA_TAG_WRITE_EVENT to fulfil write requests.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';

import { ScadaRuntimeGateway } from './scada-runtime.gateway';
import { TagManagerService } from './services/tag-manager.service';

@Module({
  imports: [
    // JwtModule is registered globally in AppModule but we import it here
    // as well so this module stays self-contained when used in isolation
    // (e.g. integration tests).  NestJS deduplicates global modules so
    // there is no double-registration risk.
    JwtModule,

    // Same rationale for ConfigModule and EventEmitterModule.
    ConfigModule,

    // EventEmitterModule powers the SCADA_TAG_WRITE_EVENT internal bus.
    // forRoot() is idempotent when called multiple times in a process.
    EventEmitterModule.forRoot(),
  ],
  providers: [
    ScadaRuntimeGateway,
    TagManagerService,
  ],
  exports: [
    // Exported so that protocol adapters (OPC UA, MQTT, Modbus) in sibling
    // modules can push tag values into the gateway and listen for writes.
    TagManagerService,
    // Exported so that the alarm engine and other services can call
    // gateway.pushAlarmStatus() / gateway.broadcastCommand() directly.
    ScadaRuntimeGateway,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ScadaRuntimeModule {}
