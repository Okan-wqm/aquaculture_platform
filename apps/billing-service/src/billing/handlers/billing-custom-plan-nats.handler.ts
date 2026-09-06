/**
 * NATS request-reply surface for custom plans (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * A custom plan is a negotiated price, so it lives with the prices; the
 * admin-panel keeps the builder UI and admin-api forwards through these
 * commands, reading the rows back through a read-only mapping.
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
  type BillingAdminCloneCustomPlanCommand,
  type BillingAdminCommandErrorCode,
  type BillingAdminCreateCustomPlanCommand,
  type BillingAdminCustomPlanCommandResult,
  type BillingAdminCustomPlanTransitionCommand,
  type BillingAdminDeleteCustomPlanResult,
  type BillingAdminRejectCustomPlanCommand,
  type BillingAdminUpdateCustomPlanCommand,
} from '@platform/event-contracts';

import { CustomPlanService, toCustomPlanSnapshot } from '../services/custom-plan.service';

/** Activation records the subscription the plan was provisioned into. */
interface ActivateCustomPlanCommand extends BillingAdminCustomPlanTransitionCommand {
  subscriptionId: string;
}

import { BillingCommandReceiptInterceptor } from '../interceptors/billing-command-receipt.interceptor';

@Controller()
@UseInterceptors(BillingCommandReceiptInterceptor)
export class BillingCustomPlanNatsHandler {
  private readonly logger = new Logger(BillingCustomPlanNatsHandler.name);

  constructor(
    private readonly customPlans: CustomPlanService,
    private readonly bypassRls: BypassRlsService,
  ) {}

  /**
   * `billing.custom_plans` IS tenant-scoped, but these commands arrive from
   * the platform-admin surface with no HTTP request context and legitimately
   * span tenants (an operator lists every tenant's plans). The audited bypass
   * is the same one the other admin handlers document, so the cross-tenant
   * access stays visible in the trail instead of being invisible.
   */
  private async runAsTrustedAdminBypass<T>(operation: string, work: () => Promise<T>): Promise<T> {
    return this.bypassRls.withBypass(`billing-custom-plan:${operation}`, work);
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.CREATE_CUSTOM_PLAN)
  async createCustomPlan(
    @Payload() command: BillingAdminCreateCustomPlanCommand,
  ): Promise<BillingAdminCustomPlanCommandResult> {
    return this.run('createCustomPlan', 'create', () =>
      this.customPlans.create(command.input, command.actorId),
    );
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.UPDATE_CUSTOM_PLAN)
  async updateCustomPlan(
    @Payload() command: BillingAdminUpdateCustomPlanCommand,
  ): Promise<BillingAdminCustomPlanCommandResult> {
    return this.run('updateCustomPlan', 'update', () =>
      this.customPlans.update(command.customPlanId, command.input, command.actorId),
    );
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.SUBMIT_CUSTOM_PLAN)
  async submitCustomPlan(
    @Payload() command: BillingAdminCustomPlanTransitionCommand,
  ): Promise<BillingAdminCustomPlanCommandResult> {
    return this.run('submitCustomPlan', 'submit', () =>
      this.customPlans.submitForApproval(command.customPlanId, command.actorId),
    );
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.APPROVE_CUSTOM_PLAN)
  async approveCustomPlan(
    @Payload() command: BillingAdminCustomPlanTransitionCommand,
  ): Promise<BillingAdminCustomPlanCommandResult> {
    return this.run('approveCustomPlan', 'approve', () =>
      this.customPlans.approve(command.customPlanId, command.actorId),
    );
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.REJECT_CUSTOM_PLAN)
  async rejectCustomPlan(
    @Payload() command: BillingAdminRejectCustomPlanCommand,
  ): Promise<BillingAdminCustomPlanCommandResult> {
    return this.run('rejectCustomPlan', 'reject', () =>
      this.customPlans.reject(command.customPlanId, command.reason, command.actorId),
    );
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.ACTIVATE_CUSTOM_PLAN)
  async activateCustomPlan(
    @Payload() command: ActivateCustomPlanCommand,
  ): Promise<BillingAdminCustomPlanCommandResult> {
    return this.run('activateCustomPlan', 'activate', () =>
      this.customPlans.activate(command.customPlanId, command.subscriptionId, command.actorId),
    );
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.CLONE_CUSTOM_PLAN)
  async cloneCustomPlan(
    @Payload() command: BillingAdminCloneCustomPlanCommand,
  ): Promise<BillingAdminCustomPlanCommandResult> {
    return this.run('cloneCustomPlan', 'clone', () =>
      this.customPlans.clone(command.customPlanId, command.targetTenantId, command.actorId),
    );
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.DELETE_CUSTOM_PLAN)
  async deleteCustomPlan(
    @Payload() command: BillingAdminCustomPlanTransitionCommand,
  ): Promise<BillingAdminDeleteCustomPlanResult> {
    return this.runAsTrustedAdminBypass('delete', async () => {
      try {
        await this.customPlans.remove(command.customPlanId, command.actorId);
        return { success: true, deleted: true };
      } catch (err) {
        const { errorCode, message } = this.mapError(err);
        this.logger.warn(`deleteCustomPlan failed: code=${errorCode}, reason=${message}`);
        return { success: false, errorCode, error: message };
      }
    });
  }

  private async run(
    operation: string,
    bypassLabel: string,
    work: () => Promise<Parameters<typeof toCustomPlanSnapshot>[0]>,
  ): Promise<BillingAdminCustomPlanCommandResult> {
    return this.runAsTrustedAdminBypass(bypassLabel, async () => {
      try {
        return { success: true, customPlan: toCustomPlanSnapshot(await work()) };
      } catch (err) {
        const { errorCode, message } = this.mapError(err);
        this.logger.warn(`${operation} failed: code=${errorCode}, reason=${message}`);
        return { success: false, errorCode, error: message };
      }
    });
  }

  private mapError(err: unknown): { errorCode: BillingAdminCommandErrorCode; message: string } {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NotFoundException) return { errorCode: 'NOT_FOUND', message };
    if (err instanceof ConflictException) return { errorCode: 'CONFLICT', message };
    if (err instanceof BadRequestException) return { errorCode: 'VALIDATION_ERROR', message };
    return { errorCode: 'INTERNAL_ERROR', message };
  }
}
