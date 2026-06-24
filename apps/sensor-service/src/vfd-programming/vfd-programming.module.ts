import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  VfdParameterDefinition,
  VfdChangeSet,
  VfdChangeSetItem,
  VfdParameterAuditLog,
  VfdAutomationRule,
} from './entities';

import {
  VfdParameterDefinitionService,
  VfdChangeSetService,
  VfdParameterWriterService,
  VfdAutomationRuleService,
  VfdChangeSetSchedulerService,
} from './services';

import { VfdProgrammingResolver, VfdAutomationResolver } from './resolvers';
import { RiskEvaluatorService } from './risk';
import { VfdModule } from '../vfd/vfd.module';

/**
 * VFD Programming Module
 *
 * Provides remote VFD parameter programming with:
 * - Maker-Checker approval workflow (IEC 62443 SL-2)
 * - Risk evaluation for parameter changes
 * - Scheduled change set application
 * - Event-driven automation rules
 * - Immutable audit trail
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      VfdParameterDefinition,
      VfdChangeSet,
      VfdChangeSetItem,
      VfdParameterAuditLog,
      VfdAutomationRule,
    ]),
    VfdModule, // Imports VfdDeviceService, VfdCommandService, VfdRegisterMappingService
  ],
  providers: [
    // Resolvers
    VfdProgrammingResolver,
    VfdAutomationResolver,
    // Services
    VfdParameterDefinitionService,
    VfdChangeSetService,
    VfdParameterWriterService,
    VfdAutomationRuleService,
    VfdChangeSetSchedulerService,
    RiskEvaluatorService,
  ],
  exports: [
    VfdParameterDefinitionService,
    VfdChangeSetService,
    VfdParameterWriterService,
    VfdAutomationRuleService,
  ],
})
 
export class VfdProgrammingModule {}
