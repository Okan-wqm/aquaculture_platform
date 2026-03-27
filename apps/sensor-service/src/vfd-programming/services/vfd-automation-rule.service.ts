import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import {
  VfdAutomationRule,
  VfdAutomationTriggerCondition,
} from '../entities/vfd-automation-rule.entity';
import { VfdParameterAuditLog } from '../entities/vfd-parameter-audit-log.entity';
import { VfdChangeSetService } from './vfd-change-set.service';
import { VfdParameterWriterService } from './vfd-parameter-writer.service';
import { VfdChangeSetStatus, VfdAuditAction } from '../../vfd/entities/vfd.enums';

interface SensorReadingEvent {
  tenantId: string;
  sensorTag: string;
  value: number;
}

interface CreateAutomationRuleInput {
  name: string;
  description?: string;
  triggerCondition: VfdAutomationTriggerCondition;
  targetVfdDeviceIds: string[];
  parameterChanges: Array<{ parameterName: string; value: number }>;
  requiresApproval?: boolean;
  priority?: number;
}

interface UpdateAutomationRuleInput {
  name?: string;
  description?: string;
  triggerCondition?: VfdAutomationTriggerCondition;
  targetVfdDeviceIds?: string[];
  parameterChanges?: Array<{ parameterName: string; value: number }>;
  requiresApproval?: boolean;
  priority?: number;
}

/**
 * VFD Automation Rule Service
 * Evaluates sensor readings against trigger conditions and creates/applies
 * change sets automatically based on automation rules.
 */
@Injectable()
export class VfdAutomationRuleService {
  private readonly logger = new Logger(VfdAutomationRuleService.name);

  constructor(
    @InjectRepository(VfdAutomationRule)
    private readonly ruleRepository: Repository<VfdAutomationRule>,
    @InjectRepository(VfdParameterAuditLog)
    private readonly auditLogRepository: Repository<VfdParameterAuditLog>,
    private readonly changeSetService: VfdChangeSetService,
    private readonly parameterWriterService: VfdParameterWriterService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── SENSOR EVENT HANDLER ────────────────────────────────────────────

  /**
   * Process a sensor reading against active automation rules.
   * Finds matching rules, evaluates conditions, and creates/applies change sets.
   */
  async onSensorReading(event: SensorReadingEvent): Promise<void> {
    const { tenantId, sensorTag, value } = event;

    const activeRules = await this.ruleRepository.find({
      where: { tenantId, isActive: true },
    });

    if (activeRules.length === 0) {
      return;
    }

    for (const rule of activeRules) {
      if (!rule.targetVfdDeviceIds || rule.targetVfdDeviceIds.length === 0) {
        continue;
      }

      try {
        await this.processRule(rule, sensorTag, value);
      } catch (error) {
        this.logger.error(
          `Error processing automation rule ${rule.id}: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────

  async createRule(
    tenantId: string,
    input: CreateAutomationRuleInput,
    createdBy: string,
  ): Promise<VfdAutomationRule> {
    const rule = this.ruleRepository.create({
      tenantId,
      name: input.name,
      description: input.description,
      triggerCondition: input.triggerCondition,
      targetVfdDeviceIds: input.targetVfdDeviceIds,
      parameterChanges: input.parameterChanges,
      requiresApproval: input.requiresApproval ?? true,
      priority: input.priority ?? 100,
      isActive: true,
      triggerCount: 0,
      createdBy,
    });

    const saved = await this.ruleRepository.save(rule);

    this.logger.log(`Automation rule ${saved.id} created: "${saved.name}" by ${createdBy}`);

    return saved;
  }

  async updateRule(
    id: string,
    input: UpdateAutomationRuleInput,
  ): Promise<VfdAutomationRule> {
    const rule = await this.findByIdOrFail(id);

    if (input.name !== undefined) rule.name = input.name;
    if (input.description !== undefined) rule.description = input.description;
    if (input.triggerCondition !== undefined) rule.triggerCondition = input.triggerCondition;
    if (input.targetVfdDeviceIds !== undefined) rule.targetVfdDeviceIds = input.targetVfdDeviceIds;
    if (input.parameterChanges !== undefined) rule.parameterChanges = input.parameterChanges;
    if (input.requiresApproval !== undefined) rule.requiresApproval = input.requiresApproval;
    if (input.priority !== undefined) rule.priority = input.priority;

    const saved = await this.ruleRepository.save(rule);

    this.logger.log(`Automation rule ${id} updated`);

    return saved;
  }

  async deleteRule(id: string): Promise<void> {
    const rule = await this.findByIdOrFail(id);
    rule.isActive = false;
    await this.ruleRepository.save(rule);
    this.logger.log(`Automation rule ${id} soft-deleted (deactivated)`);
  }

  async toggleRule(id: string, isActive: boolean): Promise<VfdAutomationRule> {
    const rule = await this.findByIdOrFail(id);
    rule.isActive = isActive;
    const saved = await this.ruleRepository.save(rule);
    this.logger.log(`Automation rule ${id} toggled to isActive=${isActive}`);
    return saved;
  }

  // ─── QUERIES ──────────────────────────────────────────────────────────

  async findByTenant(tenantId: string): Promise<VfdAutomationRule[]> {
    return this.ruleRepository.find({
      where: { tenantId },
      order: { priority: 'ASC', createdAt: 'DESC' },
    });
  }

  async findByDevice(
    tenantId: string,
    vfdDeviceId: string,
  ): Promise<VfdAutomationRule[]> {
    // Query all rules for tenant, then filter in-app since targetVfdDeviceIds is JSONB
    const rules = await this.ruleRepository.find({
      where: { tenantId, isActive: true },
      order: { priority: 'ASC' },
    });

    return rules.filter((rule) =>
      rule.targetVfdDeviceIds.includes(vfdDeviceId),
    );
  }

  async findById(id: string): Promise<VfdAutomationRule | null> {
    return this.ruleRepository.findOne({ where: { id } });
  }

  async getRuleExecutionHistory(
    ruleId: string,
    limit = 50,
  ): Promise<VfdParameterAuditLog[]> {
    return this.auditLogRepository.find({
      where: { automationRuleId: ruleId },
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  // ─── PRIVATE ──────────────────────────────────────────────────────────

  private async findByIdOrFail(id: string): Promise<VfdAutomationRule> {
    const rule = await this.ruleRepository.findOne({ where: { id } });

    if (!rule) {
      throw new NotFoundException(`Automation rule ${id} not found`);
    }

    return rule;
  }

  /**
   * Process a single automation rule against a sensor reading.
   */
  private async processRule(
    rule: VfdAutomationRule,
    sensorTag: string,
    sensorValue: number,
  ): Promise<void> {
    const { triggerCondition } = rule;

    // Check cooldown
    if (rule.lastTriggeredAt && triggerCondition.cooldownSeconds > 0) {
      const cooldownExpiry = new Date(
        rule.lastTriggeredAt.getTime() + triggerCondition.cooldownSeconds * 1000,
      );

      if (cooldownExpiry > new Date()) {
        return; // Still in cooldown
      }
    }

    // Evaluate conditions
    const triggered = this.evaluateConditions(
      triggerCondition.conditions,
      triggerCondition.logicalOperator,
      sensorTag,
      sensorValue,
    );

    if (!triggered) {
      return;
    }

    this.logger.log(
      `Automation rule "${rule.name}" (${rule.id}) triggered by sensor ${sensorTag}=${sensorValue}`,
    );

    // Create change sets for each target device
    for (const deviceId of rule.targetVfdDeviceIds) {
      try {
        await this.createAndProcessChangeSet(rule, deviceId, sensorTag, sensorValue);
      } catch (error) {
        this.logger.error(
          `Failed to process automation for device ${deviceId} (rule ${rule.id}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Update trigger stats
    rule.lastTriggeredAt = new Date();
    rule.triggerCount += 1;
    await this.ruleRepository.save(rule);

    this.eventEmitter.emit('vfd.automation.triggered', {
      ruleId: rule.id,
      ruleName: rule.name,
      tenantId: rule.tenantId,
      sensorTag,
      sensorValue,
    });
  }

  /**
   * Create a change set from an automation rule and optionally auto-apply it.
   */
  private async createAndProcessChangeSet(
    rule: VfdAutomationRule,
    deviceId: string,
    sensorTag: string,
    sensorValue: number,
  ): Promise<void> {
    const automationUser = `system:automation:${rule.id}`;

    const changeSet = await this.changeSetService.createChangeSet(
      rule.tenantId,
      {
        vfdDeviceId: deviceId,
        description: `Auto: "${rule.name}" triggered by ${sensorTag}=${sensorValue}`,
        items: rule.parameterChanges.map((pc) => ({
          parameterName: pc.parameterName,
          requestedValue: pc.value,
        })),
      },
      automationUser,
    );

    // Link change set to automation rule
    changeSet.automationRuleId = rule.id;
    changeSet.metadata = {
      ...changeSet.metadata,
      automationTrigger: { sensorTag, sensorValue, ruleId: rule.id },
    };

    if (rule.requiresApproval) {
      // Submit for approval — human must approve
      changeSet.status = VfdChangeSetStatus.PENDING_APPROVAL;
      await this.changeSetService['changeSetRepository'].save(changeSet);

      this.eventEmitter.emit('vfd.changeset.pending', {
        changeSetId: changeSet.id,
        tenantId: rule.tenantId,
        vfdDeviceId: deviceId,
        submittedBy: automationUser,
        automationRuleId: rule.id,
      });

      this.logger.log(
        `Automation change set ${changeSet.id} pending approval for device ${deviceId}`,
      );
    } else {
      // Auto-approve and apply
      changeSet.status = VfdChangeSetStatus.APPROVED;
      changeSet.approvedBy = automationUser;
      await this.changeSetService['changeSetRepository'].save(changeSet);

      const applied = await this.parameterWriterService.applyChangeSet(changeSet);

      this.logger.log(
        `Automation change set ${applied.id} auto-applied for device ${deviceId} (status: ${applied.status})`,
      );
    }
  }

  /**
   * Evaluate trigger conditions against a sensor reading.
   * Supports AND/OR logical operators across multiple conditions.
   */
  private evaluateConditions(
    conditions: VfdAutomationTriggerCondition['conditions'],
    logicalOperator: 'AND' | 'OR',
    sensorTag: string,
    sensorValue: number,
  ): boolean {
    // Only evaluate conditions that match the incoming sensor tag
    const relevantConditions = conditions.filter(
      (c) => c.sensorTag === sensorTag,
    );

    if (relevantConditions.length === 0) {
      return false;
    }

    const results = relevantConditions.map((condition) =>
      this.evaluateSingleCondition(condition.operator, sensorValue, condition.value),
    );

    if (logicalOperator === 'AND') {
      return results.every(Boolean);
    }

    return results.some(Boolean);
  }

  private evaluateSingleCondition(
    operator: '>' | '<' | '>=' | '<=' | '==' | '!=',
    sensorValue: number,
    threshold: number,
  ): boolean {
    switch (operator) {
      case '>':
        return sensorValue > threshold;
      case '<':
        return sensorValue < threshold;
      case '>=':
        return sensorValue >= threshold;
      case '<=':
        return sensorValue <= threshold;
      case '==':
        return sensorValue === threshold;
      case '!=':
        return sensorValue !== threshold;
      default:
        return false;
    }
  }
}
