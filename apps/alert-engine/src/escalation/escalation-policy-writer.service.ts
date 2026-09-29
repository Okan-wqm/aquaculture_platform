import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { EntityManager, Repository } from 'typeorm';

import {
  AlertAuditService,
  AuditCategory,
  AuditEventType,
  AuditSeverity,
} from '../audit/alert-audit.service';
import {
  EscalationPolicy,
  OnCallSchedule,
  SuppressionWindow,
} from '../database/entities/escalation-policy.entity';
import {
  EscalationPolicyService,
  type CreatePolicyDto,
  type UpdatePolicyDto,
} from './escalation-policy.service';
import type { NewSuppressionWindow } from '../database/entities/suppression-window';
import { missingLifeSafetyCoverage, type CoveragePolicyState } from './policy-coverage';

export type { NewSuppressionWindow };

/** Who is changing a policy — resolved from the JWT by the resolver. */
export interface PolicyActor {
  userId: string;
  /** TENANT_ADMIN (or above). Only such an actor may touch the default policy. */
  isTenantAdmin: boolean;
}

/**
 * EscalationPolicyWriter — every change to a tenant's escalation policies
 * (V-S1a-2, V-S1b-2, ALERT-CRITICAL-004).
 *
 * WHY a writer of its own: "the default policy cannot be disabled" used to be
 * three separate `if`s on delete/deactivate/un-default. An update WITHOUT
 * `levels` skipped validation entirely (so `severity: [INFO]` switched critical
 * alarms off), a new default silently demoted the seeded one, and any
 * MODULE_MANAGER could edit the default or add a window that muted every site.
 * One writer now funnels every write path through the same three rules:
 *
 *   1. INVARIANT — life-safety coverage. Each write computes the tenant's
 *      PROSPECTIVE policy set and refuses it (409) unless its active policies
 *      still cover CRITICAL and HIGH with a resolvable target
 *      (`missingLifeSafetyCoverage`). If violated → a tenant edit silently
 *      stops alarms from paging anyone.
 *   2. The default policy, and the `isDefault` flag itself, change only by a
 *      TENANT_ADMIN (403 otherwise).
 *   3. Every write is audit-logged on the same transaction manager, so the
 *      change and its audit row commit or roll back together.
 *
 * Each write runs in ONE transaction that first locks the tenant's policy rows
 * (`FOR UPDATE`), so two concurrent edits cannot each pass the coverage check
 * and together remove it.
 */
@Injectable()
export class EscalationPolicyWriter {
  private readonly logger = new Logger(EscalationPolicyWriter.name);

  constructor(
    @InjectRepository(EscalationPolicy)
    private readonly policyRepository: Repository<EscalationPolicy>,
    private readonly policies: EscalationPolicyService,
    private readonly audit: AlertAuditService,
  ) {}

  async createPolicy(dto: CreatePolicyDto, actor: PolicyActor): Promise<EscalationPolicy> {
    this.assertValid(dto);
    if (dto.isDefault === true) this.assertTenantAdmin(actor, 'make a policy the default');
    const windows = (dto.suppressionWindows ?? []).map((window) => this.stampWindow(window, actor));

    return this.inPolicyTransaction(dto.tenantId, async (manager, current) => {
      const created = manager.create(EscalationPolicy, {
        ...dto,
        suppressionWindows: windows.length > 0 ? windows : undefined,
        createdBy: actor.userId,
        isActive: true,
      });
      this.assertCoverage([...current, created]);
      if (dto.isDefault === true) {
        await manager.update(
          EscalationPolicy,
          { tenantId: dto.tenantId, isDefault: true },
          { isDefault: false },
        );
      }
      const saved = await manager.save(EscalationPolicy, created);
      await this.recordChange(manager, actor, saved, AuditEventType.POLICY_CREATED, 'created', {
        newState: this.snapshot(saved),
      });
      return saved;
    });
  }

  async updatePolicy(
    id: string,
    tenantId: string,
    dto: UpdatePolicyDto,
    actor: PolicyActor,
  ): Promise<EscalationPolicy> {
    return this.inPolicyTransaction(tenantId, async (manager, current) => {
      const policy = this.find(current, id);
      if (policy.isDefault || dto.isDefault === true) {
        this.assertTenantAdmin(actor, 'change the default policy');
      }
      if (policy.isDefault && dto.isDefault === false) {
        throw new ConflictException(
          'Cannot unset the default policy; make another policy the default instead',
        );
      }
      if (policy.isDefault && dto.isActive === false) {
        throw new ConflictException('Cannot deactivate the default policy');
      }

      const next = manager.create(EscalationPolicy, { ...policy, ...dto, tenantId });
      // Validated whole, whatever the update names — an update without
      // `levels` used to skip validation and could empty `severity`.
      this.assertValid(next);
      const becomesDefault = dto.isDefault === true && !policy.isDefault;
      this.assertCoverage(current.map((p) => (p.id === id ? next : p)));
      if (becomesDefault) {
        await manager.update(EscalationPolicy, { tenantId, isDefault: true }, { isDefault: false });
      }
      const saved = await manager.save(EscalationPolicy, next);
      await this.recordChange(manager, actor, saved, AuditEventType.POLICY_UPDATED, 'updated', {
        previousState: this.snapshot(policy),
        newState: this.snapshot(saved),
      });
      return saved;
    });
  }

  async deletePolicy(id: string, tenantId: string, actor: PolicyActor): Promise<void> {
    await this.inPolicyTransaction(tenantId, async (manager, current) => {
      const policy = this.find(current, id);
      if (policy.isDefault) {
        throw new ConflictException('Cannot delete default policy');
      }
      this.assertCoverage(current.filter((p) => p.id !== id));
      await manager.remove(EscalationPolicy, policy);
      await this.recordChange(manager, actor, policy, AuditEventType.POLICY_DELETED, 'deleted', {
        previousState: this.snapshot(policy),
      });
    });
  }

  async addSuppressionWindow(
    policyId: string,
    tenantId: string,
    window: NewSuppressionWindow,
    actor: PolicyActor,
  ): Promise<EscalationPolicy> {
    const added = this.stampWindow(window, actor);
    return this.inPolicyTransaction(tenantId, async (manager, current) => {
      const policy = this.find(current, policyId);
      if (policy.isDefault) this.assertTenantAdmin(actor, 'change the default policy');
      policy.suppressionWindows = [...(policy.suppressionWindows ?? []), added];
      const saved = await manager.save(EscalationPolicy, policy);
      await this.recordChange(
        manager,
        actor,
        saved,
        AuditEventType.POLICY_UPDATED,
        `suppression window "${added.name}" added (${added.startTime.toISOString()} – ` +
          `${added.endTime.toISOString()}, silences ${added.createdByTenantAdmin ? 'HIGH and lower' : 'below HIGH'})`,
        { newState: { suppressionWindow: { ...added } } },
      );
      return saved;
    });
  }

  async removeSuppressionWindow(
    policyId: string,
    tenantId: string,
    windowId: string,
    actor: PolicyActor,
  ): Promise<EscalationPolicy> {
    return this.inPolicyTransaction(tenantId, async (manager, current) => {
      const policy = this.find(current, policyId);
      if (policy.isDefault) this.assertTenantAdmin(actor, 'change the default policy');
      const windows = policy.suppressionWindows ?? [];
      const removed = windows.find((w) => w.id === windowId);
      if (!removed) {
        throw new NotFoundException(`Suppression window ${windowId} not found`);
      }
      policy.suppressionWindows = windows.filter((w) => w.id !== windowId);
      const saved = await manager.save(EscalationPolicy, policy);
      await this.recordChange(
        manager,
        actor,
        saved,
        AuditEventType.POLICY_UPDATED,
        `suppression window "${removed.name}" removed`,
        { previousState: { suppressionWindow: { ...removed } } },
      );
      return saved;
    });
  }

  async updateOnCallSchedule(
    policyId: string,
    tenantId: string,
    schedule: OnCallSchedule[],
    actor: PolicyActor,
  ): Promise<EscalationPolicy> {
    return this.inPolicyTransaction(tenantId, async (manager, current) => {
      const policy = this.find(current, policyId);
      if (policy.isDefault) this.assertTenantAdmin(actor, 'change the default policy');
      const next = manager.create(EscalationPolicy, { ...policy, onCallSchedule: schedule });
      this.assertValid(next);
      this.assertCoverage(current.map((p) => (p.id === policyId ? next : p)));
      const saved = await manager.save(EscalationPolicy, next);
      await this.recordChange(
        manager,
        actor,
        saved,
        AuditEventType.POLICY_UPDATED,
        'on-call schedule updated',
        {
          previousState: { onCallSchedule: policy.onCallSchedule ?? [] },
          newState: { onCallSchedule: schedule },
        },
      );
      return saved;
    });
  }

  /**
   * Copy a policy under a new name. The copy is never the default and starts
   * with no suppression windows — a window is a time-bound decision about THIS
   * policy, not a property a copy may inherit.
   */
  async clonePolicy(
    id: string,
    tenantId: string,
    newName: string,
    actor: PolicyActor,
  ): Promise<EscalationPolicy> {
    return this.inPolicyTransaction(tenantId, async (manager, current) => {
      const source = this.find(current, id);
      const clone = manager.create(EscalationPolicy, {
        tenantId,
        name: newName,
        description: source.description,
        severity: [...source.severity],
        levels: source.levels,
        onCallSchedule: source.onCallSchedule,
        suppressionWindows: undefined,
        repeatIntervalMinutes: source.repeatIntervalMinutes,
        maxRepeats: source.maxRepeats,
        isActive: source.isActive,
        isDefault: false,
        priority: source.priority,
        conditions: source.conditions,
        timezone: source.timezone,
        ruleIds: source.ruleIds,
        farmIds: source.farmIds,
        createdBy: actor.userId,
      });
      const saved = await manager.save(EscalationPolicy, clone);
      await this.recordChange(
        manager,
        actor,
        saved,
        AuditEventType.POLICY_CREATED,
        `cloned from ${source.id}`,
        {
          newState: this.snapshot(saved),
        },
      );
      return saved;
    });
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * Run `fn` in one transaction holding a row lock on every policy of the
   * tenant. The manager is bound to the caller's tenant context (search_path +
   * RLS), exactly like the repository it comes from.
   */
  private async inPolicyTransaction<T>(
    tenantId: string,
    fn: (manager: EntityManager, current: EscalationPolicy[]) => Promise<T>,
  ): Promise<T> {
    const result = await this.policyRepository.manager.transaction(async (manager) => {
      const current = await manager.find(EscalationPolicy, {
        where: { tenantId },
        order: { createdAt: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      return fn(manager, current);
    });
    this.policies.invalidateCache(tenantId);
    return result;
  }

  /** Give a requested window its id, creator and admin flag (and check its span). */
  private stampWindow(window: NewSuppressionWindow, actor: PolicyActor): SuppressionWindow {
    if (window.endTime.getTime() <= window.startTime.getTime()) {
      throw new ConflictException('A suppression window must end after it starts');
    }
    return {
      ...window,
      id: randomUUID(),
      createdBy: actor.userId,
      // ALERT-3: only an admin's window may silence a HIGH alarm; CRITICAL is
      // never silenced (EscalationPolicy.suppresses).
      createdByTenantAdmin: actor.isTenantAdmin,
    };
  }

  private find(current: readonly EscalationPolicy[], id: string): EscalationPolicy {
    const policy = current.find((candidate) => candidate.id === id);
    if (!policy) {
      throw new NotFoundException(`Policy ${id} not found`);
    }
    return policy;
  }

  private assertValid(dto: CreatePolicyDto | UpdatePolicyDto | EscalationPolicy): void {
    const validation = this.policies.validatePolicy({
      name: dto.name,
      severity: dto.severity,
      levels: dto.levels,
      onCallSchedule: dto.onCallSchedule,
      repeatIntervalMinutes: dto.repeatIntervalMinutes,
      maxRepeats: dto.maxRepeats,
    });
    if (!validation.isValid) {
      throw new ConflictException(`Invalid policy: ${validation.errors.join(', ')}`);
    }
  }

  private assertCoverage(prospective: readonly CoveragePolicyState[]): void {
    const missing = missingLifeSafetyCoverage(prospective);
    if (missing.length > 0) {
      throw new ConflictException(
        `This change would leave ${missing.join(' and ')} alarms with no active policy that ` +
          'pages somebody. Keep at least one active, unfiltered policy for each with a recipient.',
      );
    }
  }

  private assertTenantAdmin(actor: PolicyActor, what: string): void {
    if (!actor.isTenantAdmin) {
      throw new ForbiddenException(`Only a tenant admin can ${what}`);
    }
  }

  private snapshot(policy: EscalationPolicy): Record<string, unknown> {
    return {
      name: policy.name,
      severity: policy.severity,
      levels: policy.levels,
      isActive: policy.isActive,
      isDefault: policy.isDefault,
      priority: policy.priority,
      ruleIds: policy.ruleIds ?? [],
      farmIds: policy.farmIds ?? [],
      onCallSchedule: policy.onCallSchedule ?? [],
    };
  }

  private async recordChange(
    manager: EntityManager,
    actor: PolicyActor,
    policy: EscalationPolicy,
    eventType: AuditEventType,
    action: string,
    states: { previousState?: Record<string, unknown>; newState?: Record<string, unknown> },
  ): Promise<void> {
    const touchesDefault = policy.isDefault || states.previousState?.['isDefault'] === true;
    await this.audit.recordInTransaction(manager, {
      category: AuditCategory.CONFIGURATION,
      eventType,
      severity: touchesDefault ? AuditSeverity.WARNING : AuditSeverity.INFO,
      entityType: 'EscalationPolicy',
      entityId: policy.id,
      tenantId: policy.tenantId,
      userId: actor.userId,
      action: `escalation_policy.${eventType.toLowerCase()}`,
      description: `Escalation policy "${policy.name}" ${action}`,
      ...states,
      metadata: { isDefault: policy.isDefault, actorIsTenantAdmin: actor.isTenantAdmin },
      success: true,
    });
    this.logger.log(
      `Escalation policy ${policy.id} ${action} by ${actor.userId.substring(0, 8)}... ` +
        `(tenant ${policy.tenantId.substring(0, 8)}...)`,
    );
  }
}
