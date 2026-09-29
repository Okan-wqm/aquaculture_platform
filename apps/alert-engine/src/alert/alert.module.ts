import { NatsV3Client } from '@aquaculture/backend-common/nats';
import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
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
import { FarmSignalIncidentService } from './services/farm-signal-incident.service';
import { MortalityAlertService } from './services/mortality-alert.service';
import { LowStockAlertService } from './services/low-stock-alert.service';
import { FcrAlertService } from './services/fcr-alert.service';
import { FeedCoverageAlertService } from './services/feed-coverage-alert.service';
import { FeedingExecutionAlertService } from './services/feeding-execution-alert.service';
import { WaterQualityCriticalAlertService } from './services/water-quality-critical-alert.service';
import {
  ALERT_AUTH_NATS_CLIENT,
  RuleRecipientNormalizer,
} from './services/rule-recipient-normalizer.service';
import { RuleRecipientBackfillService } from './services/rule-recipient-backfill.service';
import { AlertAuditService } from '../audit/alert-audit.service';

// Escalation services
import { EscalationManagerService } from '../escalation/escalation-manager.service';
import { EscalationPolicyService } from '../escalation/escalation-policy.service';
import { EscalationPolicyWriter } from '../escalation/escalation-policy-writer.service';
import { AcknowledgmentTrackerService } from '../escalation/acknowledgment-tracker.service';
import { DefaultPolicyProvisioningHandler } from '../escalation/default-policy-provisioning.handler';
import { DefaultPolicyReconcilerService } from '../escalation/default-policy-reconciler.service';

// Event Handlers
import { SensorReadingEventHandler } from './event-handlers/sensor-reading.handler';
import { MortalityAlertEventHandler } from './event-handlers/mortality-alert.handler';
import { LowStockEventHandler } from './event-handlers/low-stock.handler';
import { FcrAlertEventHandler } from './event-handlers/fcr-alert.handler';
import { FeedCoverageEventHandler } from './event-handlers/feed-coverage.handler';
import { FeedingExecutionEventHandler } from './event-handlers/feeding-execution.handler';
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
    // Decision 7: auth-service user queries (rule recipient normalisation) on
    // the alert_engine mTLS identity; services.yaml grants exactly
    // `request.auth.user.resolveTenantUserIdsByEmail`.
    ClientsModule.register([
      {
        name: ALERT_AUTH_NATS_CLIENT,
        customClass: NatsV3Client,
        options: { serviceName: 'alert-engine' },
      },
    ]),
  ],
  providers: [
    // Services
    AlertEvaluationService,
    AlertRuleService,
    FarmSignalIncidentService,
    MortalityAlertService,
    LowStockAlertService,
    FcrAlertService,
    FeedCoverageAlertService,
    FeedingExecutionAlertService,
    WaterQualityCriticalAlertService,
    AlertAuditService,
    // Decision 7: sensor-rule recipients — people as user ids (write path +
    // hourly backfill of existing rules).
    RuleRecipientNormalizer,
    RuleRecipientBackfillService,

    // Escalation services
    EscalationPolicyService,
    // V-S1a-2 / V-S1b-2: every policy write (coverage invariant, admin-only
    // default changes, audited in the same transaction).
    EscalationPolicyWriter,
    EscalationManagerService,
    AcknowledgmentTrackerService,
    // ALERT-CRITICAL-004: every tenant has a default escalation policy —
    // seeded on TenantProvisioned and re-asserted by a periodic reconcile.
    DefaultPolicyProvisioningHandler,
    DefaultPolicyReconcilerService,

    // Event Handlers
    SensorReadingEventHandler,
    MortalityAlertEventHandler,
    LowStockEventHandler,
    FcrAlertEventHandler,
    FeedCoverageEventHandler,
    FeedingExecutionEventHandler,
    WaterQualityCriticalEventHandler,

    // Resolvers
    AlertResolver,
    EscalationPolicyResolver,
  ],
  exports: [AlertEvaluationService, AlertRuleService, EscalationManagerService, AcknowledgmentTrackerService, AlertAuditService],
})
export class AlertModule {}
