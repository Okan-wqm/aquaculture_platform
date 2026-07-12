/**
 * ScadaRuntimeModule
 *
 * NestJS module that wires together the SCADA HMI operator runtime:
 *  - ScadaRuntimeGateway  — Socket.IO WebSocket gateway (/scada namespace)
 *  - TagManagerService    — In-memory tag subscription + value cache
 *  - AlarmEngineService   — 1-second alarm evaluation loop
 *  - AlarmStorageService  — TypeORM-backed alarm persistence
 *  - NotificationService  — Email / webhook alarm notifications
 *  - DaqStorageService    — TimescaleDB historical tag value storage
 *  - ScriptEngineService  — Script execution sandbox (registered when available)
 *  - SchedulerService     — Cron / interval-based task scheduler (registered when available)
 *
 * External dependencies consumed (must be globally available):
 *  - JwtModule (registered as global in AppModule)
 *  - ConfigModule (registered as global in AppModule)
 *  - EventEmitterModule (registered in RegistrationModule; ensured here as well)
 *  - TypeOrmModule (registered globally via forRootAsync in AppModule — DataSource
 *    injected into AlarmStorageService and DaqStorageService via @InjectDataSource())
 *
 * The module exports TagManagerService so that device-driver adapters
 * (OPC UA, MQTT, Modbus, etc.) living in sibling modules can call
 * `tagManager.updateTagValues()` to push live data through the gateway,
 * and listen for the SCADA_TAG_WRITE_EVENT to fulfil write requests.
 */

import { Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { JwtModule } from '@nestjs/jwt';

import { ProcessModule } from '../process/process.module';

import { ScadaRuntimeGateway } from './scada-runtime.gateway';
import { TagManagerService } from './services/tag-manager.service';
import { AlarmEngineService } from './services/alarm-engine.service';
import { AlarmStorageService } from './services/alarm-storage.service';
import { NotificationService } from './services/notification.service';
import { DaqStorageService } from './services/daq-storage.service';
import { TagValueFanoutService } from './services/tag-value-fanout.service';

/* ------------------------------------------------------------------ */
/*  Optional services (may still be in progress from other agents)     */
/* ------------------------------------------------------------------ */

/**
 * Attempt to import ScriptEngineService.  If the file does not yet exist
 * (another agent is still writing it) we silently skip it so the rest of
 * the module remains functional.
 */
let ScriptEngineService: (new (...args: unknown[]) => unknown) | null = null;
try {
   
  const mod = require('./services/script-engine.service') as Record<string, unknown>;
  ScriptEngineService = (mod['ScriptEngineService'] ?? null) as typeof ScriptEngineService;
} catch {
  // File not yet available — skip registration.
}

/**
 * Attempt to import SchedulerService.  Same rationale as above.
 */
let SchedulerService: (new (...args: unknown[]) => unknown) | null = null;
try {
   
  const mod = require('./services/scheduler.service') as Record<string, unknown>;
  SchedulerService = (mod['SchedulerService'] ?? null) as typeof SchedulerService;
} catch {
  // File not yet available — skip registration.
}

/* ------------------------------------------------------------------ */
/*  Build optional provider list                                        */
/* ------------------------------------------------------------------ */

const optionalProviders: Provider[] = [];
if (ScriptEngineService) optionalProviders.push(ScriptEngineService as Provider);
if (SchedulerService) optionalProviders.push(SchedulerService as Provider);

/* ------------------------------------------------------------------ */
/*  Module                                                              */
/* ------------------------------------------------------------------ */

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

    // Faz 6: TagResolutionService (exported by ProcessModule) validates
    // socket subscribe keys against the tenant's unified_tags registry.
    ProcessModule,
  ],
  providers: [
    ScadaRuntimeGateway,
    TagManagerService,
    AlarmEngineService,
    AlarmStorageService,
    NotificationService,
    DaqStorageService,
    // Live-data producer: bridges ingested sensor metrics onto the gateway's
    // tenant-fenced tag fan-out via the registry's sensor→fqn linkage.
    TagValueFanoutService,
    // ScriptEngineService and SchedulerService registered only when their
    // source files are present (see optional-import block above).
    ...optionalProviders,
  ],
  exports: [
    // Exported so that protocol adapters (OPC UA, MQTT, Modbus) in sibling
    // modules can push tag values into the gateway and listen for writes.
    TagManagerService,
    // Exported so that consumers can evaluate / acknowledge alarms directly.
    AlarmEngineService,
    // Exported so that protocol adapters can persist historical tag data.
    DaqStorageService,
    // Exported so that the alarm engine and other services can call
    // gateway.pushAlarmStatus() / gateway.broadcastCommand() directly.
    ScadaRuntimeGateway,
    // Exported so the ingestion consumer can fan ingested metrics out to
    // subscribed operator sockets (the live-data producer).
    TagValueFanoutService,
  ],
})
 
export class ScadaRuntimeModule {}
