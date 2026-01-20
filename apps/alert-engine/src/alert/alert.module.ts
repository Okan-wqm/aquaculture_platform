import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { AlertRule } from '../database/entities/alert-rule.entity';
import { AlertHistory } from './entities/alert-history.entity';

// Services
import { AlertEvaluationService } from './services/alert-evaluation.service';
import { AlertRuleService } from './services/alert-rule.service';

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
 */
@Module({
  imports: [TypeOrmModule.forFeature([AlertRule, AlertHistory])],
  providers: [
    // Services
    AlertEvaluationService,
    AlertRuleService,

    // Event Handlers
    SensorReadingEventHandler,

    // Resolvers
    AlertResolver,
  ],
  exports: [AlertEvaluationService, AlertRuleService],
})
export class AlertModule {}
