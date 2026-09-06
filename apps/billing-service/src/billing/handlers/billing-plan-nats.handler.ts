/**
 * NATS request-reply surface for the plan catalogue (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * `billing.plans` is the only catalogue: every runtime path resolves it, and
 * `admin.plan_definitions` — whose ids never resolved at execution — is gone.
 * admin-api keeps the PlanManagement page and authors through these commands.
 */
import {
  BadRequestException,
  ConflictException,
  Controller,
  Logger,
  NotFoundException,
  UseInterceptors,
} from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import {
  BILLING_ADMIN_COMMAND_SUBJECTS,
  type BillingAdminCommandErrorCode,
  type BillingAdminCreatePlanCommand,
  type BillingAdminDeprecatePlanCommand,
  type BillingAdminPlanCommandResult,
  type BillingAdminUpdatePlanCommand,
} from '@platform/event-contracts';

import { PlanCatalogService, toPlanSnapshot } from '../services/plan-catalog.service';

import { BillingCommandReceiptInterceptor } from '../interceptors/billing-command-receipt.interceptor';

@Controller()
@UseInterceptors(BillingCommandReceiptInterceptor)
export class BillingPlanNatsHandler {
  private readonly logger = new Logger(BillingPlanNatsHandler.name);

  constructor(
    private readonly plans: PlanCatalogService,
    private readonly bypassRls: BypassRlsService,
  ) {}

  /**
   * `billing.plans` is a cross-tenant catalogue with no tenantId column, so no
   * tenant policy applies to it — but these commands arrive with no HTTP
   * request context at all, and the same audited bypass the other admin
   * handlers document keeps the cross-tenant access visible in the trail.
   */
  private async runAsTrustedAdminBypass<T>(operation: string, work: () => Promise<T>): Promise<T> {
    return this.bypassRls.withBypass(`billing-plan:${operation}`, work);
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.CREATE_PLAN)
  async createPlan(
    @Payload() command: BillingAdminCreatePlanCommand,
  ): Promise<BillingAdminPlanCommandResult> {
    return this.runAsTrustedAdminBypass('create-plan', async () => {
      try {
        const plan = await this.plans.create(command.input, command.actorId);
        return { success: true, plan: toPlanSnapshot(plan) };
      } catch (err) {
        return this.toError('createPlan', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.UPDATE_PLAN)
  async updatePlan(
    @Payload() command: BillingAdminUpdatePlanCommand,
  ): Promise<BillingAdminPlanCommandResult> {
    return this.runAsTrustedAdminBypass('update-plan', async () => {
      try {
        const plan = await this.plans.update(command.planId, command.input, command.actorId);
        return { success: true, plan: toPlanSnapshot(plan) };
      } catch (err) {
        return this.toError('updatePlan', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.DEPRECATE_PLAN)
  async deprecatePlan(
    @Payload() command: BillingAdminDeprecatePlanCommand,
  ): Promise<BillingAdminPlanCommandResult> {
    return this.runAsTrustedAdminBypass('deprecate-plan', async () => {
      try {
        const plan = await this.plans.deprecate(command.planId, command.actorId);
        return { success: true, plan: toPlanSnapshot(plan) };
      } catch (err) {
        return this.toError('deprecatePlan', err);
      }
    });
  }

  private toError(operation: string, err: unknown): BillingAdminPlanCommandResult {
    const { errorCode, message } = this.mapError(err);
    this.logger.warn(`${operation} failed: code=${errorCode}, reason=${message}`);
    return { success: false, errorCode, error: message };
  }

  private mapError(err: unknown): { errorCode: BillingAdminCommandErrorCode; message: string } {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NotFoundException) return { errorCode: 'NOT_FOUND', message };
    if (err instanceof ConflictException) return { errorCode: 'CONFLICT', message };
    if (err instanceof BadRequestException) return { errorCode: 'VALIDATION_ERROR', message };
    return { errorCode: 'INTERNAL_ERROR', message };
  }
}
