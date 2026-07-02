import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { AlertRule } from '../database/entities/alert-rule.entity';
import { AlertHistory } from './entities/alert-history.entity';
import { AlertIncident } from '../database/entities/alert-incident.entity';
import { EscalationPolicy } from '../database/entities/escalation-policy.entity';
import { AuditEntryEntity } from '../audit/entities/audit-entry.entity';

// Services
import { AlertEvaluationService } from './services/alert-evaluation.service';
import { AlertRuleService } from './services/alert-rule.service';
import { MortalityAlertService } from './services/mortality-alert.service';
import { WaterQualityCriticalAlertService } from './services/water-quality-critical-alert.service';
import { AlertAuditService } from '../audit/alert-audit.service';

// Escalation services
import { EscalationManagerService } from '../escalation/escalation-manager.service';
import { EscalationPolicyService } from '../escalation/escalation-policy.service';
import { AcknowledgmentTrackerService } from '../escalation/acknowledgment-tracker.service';

// Event Handlers
import { SensorReadingEventHandler } from './event-handlers/sensor-reading.handler';
import { MortalityAlertEventHandler } from './event-handlers/mortality-alert.handler';
import { WaterQualityCriticalEventHandler } from './event-handlers/water-quality-critical.handler';

// Resolvers
import { AlertResolver } from './resolvers/alert.resolver';
import { EscalationPolicyResolver } from './resolvers/escalation-policy.resolver';

/**
 * Alert Module
 * Contains all alert-related functionality including:
 * - Alert rule management
 * - Real-time sensor reading evaluation
 * - Alert history tracking
 * - Alert acknowledgement and resolution
 * - Incident creation and escalation pipeline
 *
 * NOTE: The `rules-engine/` directory (RulesEngineService, RuleEvaluatorService,
 * BehaviorTreeService, JsonRulesService, OpaRulesService, safe-regex.util) is
 * NOT registered in this module. Those files are dead code marked @deprecated
 * and scheduled for removal (D10-F3). Alert evaluation uses
 * AlertEvaluationService instead.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AlertRule,
      AlertHistory,
      AlertIncident,
      EscalationPolicy,
      AuditEntryEntity,
    ]),
  ],
  providers: [
    // Services
    AlertEvaluationService,
    AlertRuleService,
    MortalityAlertService,
    WaterQualityCriticalAlertService,
    AlertAuditService,

    // Escalation services
    EscalationPolicyService,
    EscalationManagerService,
    AcknowledgmentTrackerService,

    // Event Handlers
    SensorReadingEventHandler,
    MortalityAlertEventHandler,
    WaterQualityCriticalEventHandler,

    // Resolvers
    AlertResolver,
    EscalationPolicyResolver,
  ],
  exports: [AlertEvaluationService, AlertRuleService, EscalationManagerService, AcknowledgmentTrackerService, AlertAuditService],
})
export class AlertModule {}
