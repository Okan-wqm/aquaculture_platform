import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UnifiedTag } from '../../process/entities/unified-tag.entity';
import { AutomationProgram } from '../entities/automation-program.entity';
import { ProgramVariable } from '../entities/program-variable.entity';
import { AutomationEventsPublisher } from '../events/automation-events.publisher';

import { COMPILER_SERVICE } from './services/compiler.interface';
import { CompilerService } from './services/compiler.service';
import { STIntellisenseService } from './services/st-intellisense.service';
import { STLanguageService } from './services/st-language.service';
import { STWorkerPoolService } from './worker/st-worker-pool.service';
import { STLanguageHandler } from './nats-handlers/st-language.handler';

/**
 * Compiler Module
 *
 * Provides the ST language service stack:
 * - STLanguageService: orchestration layer
 * - STIntellisenseService: DB-driven completions (tags, FBs, variables)
 * - STWorkerPoolService: CPU-bound parsing in worker threads
 * - CompilerService: mock compiler (Faz 1) / Codesys (Faz 2)
 * - STLanguageHandler: NATS request-reply handler
 * - AutomationEventsPublisher: NATS event publishing
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      UnifiedTag,
      AutomationProgram,
      ProgramVariable,
    ]),
  ],
  providers: [
    STLanguageService,
    STIntellisenseService,
    STWorkerPoolService,
    {
      provide: COMPILER_SERVICE,
      useClass: CompilerService,
    },
    CompilerService,
    STLanguageHandler,
    AutomationEventsPublisher,
  ],
  exports: [
    STLanguageService,
    STIntellisenseService,
    STWorkerPoolService,
    COMPILER_SERVICE,
    CompilerService,
    AutomationEventsPublisher,
  ],
})
 
export class CompilerModule {}
