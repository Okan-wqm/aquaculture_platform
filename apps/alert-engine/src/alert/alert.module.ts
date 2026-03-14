import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { AlertRule } from '../database/entities/alert-rule.entity';
import { AlertHistory } from './entities/alert-history.entity';
import { AlertIncident } from '../database/entities/alert-incident.entity';
import { EscalationPolicy } from '../database/entities/escalation-policy.entity';

// Services
import { AlertEvaluationService } from './services/alert-evaluation.service';
import { AlertRuleService } from './services/alert-rule.service';

// Escalation services
import { EscalationManagerService } from '../escalation/escalation-manager.service';
import { EscalationPolicyService } from '../escalation/escalation-policy.service';
import { AcknowledgmentTrackerService } from '../escalation/acknowledgment-tracker.service';

// Event Handlers
import { SensorReadingEventHandler } from './event-handlers/sensor-reading.handler';

// Resolvers
import { AlertResolver } from './resolvers/alert.resolver';

/**
 * Alert Module
 * Contains all alert-related functionality including:
 * - Alert rule management
 * - Real-time sensor reading evaluation
 * - Alert history tracking
 * - Alert acknowledgement and resolution
 * - Incident creation and escalation pipeline
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AlertRule,
      AlertHistory,
      AlertIncident,
      EscalationPolicy,
    ]),
  ],
  providers: [
    // Services
    AlertEvaluationService,
    AlertRuleService,

    // Escalation services
    EscalationPolicyService,
    EscalationManagerService,
    AcknowledgmentTrackerService,

    // Event Handlers
    SensorReadingEventHandler,

    // Resolvers
    AlertResolver,
  ],
  exports: [AlertEvaluationService, AlertRuleService, EscalationManagerService, AcknowledgmentTrackerService],
})
export class AlertModule {}
