/**
 * NATS request-reply surface for the discount catalogue (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * admin-api-service owns the platform-admin REST facade, billing owns the
 * rows. Every discount write arrives here as a cert-CN-authenticated command
 * on `request.billing.admin.*Discount*`; admin-api holds no repository for
 * these tables and only reads them through a read-only mapping.
 *
 * A refusal by a business rule (`DiscountRejectedError` — expired, capped,
 * plan-ineligible) is NOT an error: `validate` and `apply` answer
 * `success: true, valid: false` with the reason, so the caller renders the
 * refusal instead of a 502. Only a malformed command or a broken invariant
 * comes back as an errorCode.
 */
import { BadRequestException, Controller, Logger, NotFoundException } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import {
  BILLING_ADMIN_COMMAND_SUBJECTS,
  type BillingAdminApplyDiscountCodeCommand,
  type BillingAdminApplyDiscountCodeResult,
  type BillingAdminBulkCreateDiscountCodesCommand,
  type BillingAdminBulkDiscountCodeCommandResult,
  type BillingAdminCommandErrorCode,
  type BillingAdminCreateDiscountCodeCommand,
  type BillingAdminDeactivateDiscountCodeCommand,
  type BillingAdminDiscountCodeCommandResult,
  type BillingAdminGenerateDiscountCodeCommand,
  type BillingAdminGenerateDiscountCodeResult,
  type BillingAdminUpdateDiscountCodeCommand,
  type BillingAdminValidateDiscountCodeCommand,
  type BillingAdminValidateDiscountCodeResult,
} from '@platform/event-contracts';
import Decimal from 'decimal.js';

import {
  DiscountCodeService,
  DiscountRejectedError,
  toDiscountCodeSnapshot,
} from '../services/discount-code.service';

@Controller()
export class BillingDiscountNatsHandler {
  private readonly logger = new Logger(BillingDiscountNatsHandler.name);

  constructor(
    private readonly discounts: DiscountCodeService,
    private readonly bypassRls: BypassRlsService,
  ) {}

  /**
   * Same audited bypass `BillingAdminNatsHandler` documents: these commands
   * arrive with no HTTP request context, so `app.current_tenant` is unset and
   * `billing.discount_redemptions`' tenant_isolation_policy would deny every
   * read and write. Each redemption still writes `tenant_id` explicitly — the
   * bypass lets the row through, it never decides which tenant it belongs to.
   */
  private async runAsTrustedAdminBypass<T>(operation: string, work: () => Promise<T>): Promise<T> {
    return this.bypassRls.withBypass(`billing-discount:${operation}`, work);
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.CREATE_DISCOUNT_CODE)
  async createDiscountCode(
    @Payload() command: BillingAdminCreateDiscountCodeCommand,
  ): Promise<BillingAdminDiscountCodeCommandResult> {
    return this.runAsTrustedAdminBypass('create-discount-code', async () => {
      try {
        const created = await this.discounts.create(command.code, command.input, command.actorId);
        return { success: true, discountCode: toDiscountCodeSnapshot(created) };
      } catch (err) {
        return this.toCommandError('createDiscountCode', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.UPDATE_DISCOUNT_CODE)
  async updateDiscountCode(
    @Payload() command: BillingAdminUpdateDiscountCodeCommand,
  ): Promise<BillingAdminDiscountCodeCommandResult> {
    return this.runAsTrustedAdminBypass('update-discount-code', async () => {
      try {
        const updated = await this.discounts.update(
          command.discountCodeId,
          command.input,
          command.actorId,
        );
        return { success: true, discountCode: toDiscountCodeSnapshot(updated) };
      } catch (err) {
        return this.toCommandError('updateDiscountCode', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.DEACTIVATE_DISCOUNT_CODE)
  async deactivateDiscountCode(
    @Payload() command: BillingAdminDeactivateDiscountCodeCommand,
  ): Promise<BillingAdminDiscountCodeCommandResult> {
    return this.runAsTrustedAdminBypass('deactivate-discount-code', async () => {
      try {
        const deactivated = await this.discounts.deactivate(
          command.discountCodeId,
          command.actorId,
        );
        return { success: true, discountCode: toDiscountCodeSnapshot(deactivated) };
      } catch (err) {
        return this.toCommandError('deactivateDiscountCode', err);
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.BULK_CREATE_DISCOUNT_CODES)
  async bulkCreateDiscountCodes(
    @Payload() command: BillingAdminBulkCreateDiscountCodesCommand,
  ): Promise<BillingAdminBulkDiscountCodeCommandResult> {
    return this.runAsTrustedAdminBypass('bulk-create-discount-codes', async () => {
      try {
        const created = await this.discounts.bulkCreate(
          command.count,
          command.template,
          command.actorId,
          command.codePrefix,
        );
        return { success: true, discountCodes: created.map(toDiscountCodeSnapshot) };
      } catch (err) {
        const { errorCode, message } = this.mapError(err);
        this.logger.warn(`bulkCreateDiscountCodes failed: code=${errorCode}, reason=${message}`);
        return { success: false, errorCode, error: message };
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.GENERATE_DISCOUNT_CODE)
  async generateDiscountCode(
    @Payload() command: BillingAdminGenerateDiscountCodeCommand,
  ): Promise<BillingAdminGenerateDiscountCodeResult> {
    return this.runAsTrustedAdminBypass('generate-discount-code', async () => {
      try {
        const code = await this.discounts.generateUniqueCode(command.prefix, command.length);
        return { success: true, code };
      } catch (err) {
        const { errorCode, message } = this.mapError(err);
        this.logger.warn(`generateDiscountCode failed: code=${errorCode}, reason=${message}`);
        return { success: false, errorCode, error: message };
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.VALIDATE_DISCOUNT_CODE)
  async validateDiscountCode(
    @Payload() command: BillingAdminValidateDiscountCodeCommand,
  ): Promise<BillingAdminValidateDiscountCodeResult> {
    return this.runAsTrustedAdminBypass('validate-discount-code', async () => {
      try {
        const validation = await this.discounts.validate(command.code, command.tenantId, {
          planId: command.planId,
          subscriptionChange: command.subscriptionChange,
          orderAmount:
            command.orderAmount === undefined ? undefined : new Decimal(command.orderAmount),
        });
        return {
          success: true,
          valid: validation.valid,
          reason: validation.reason,
          message: validation.message,
          discountAmount: validation.discountAmount?.toString(),
          discountCode: validation.discountCode
            ? toDiscountCodeSnapshot(validation.discountCode)
            : undefined,
        };
      } catch (err) {
        const { errorCode, message } = this.mapError(err);
        this.logger.warn(`validateDiscountCode failed: code=${errorCode}, reason=${message}`);
        return { success: false, valid: false, errorCode, error: message };
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.APPLY_DISCOUNT_CODE)
  async applyDiscountCode(
    @Payload() command: BillingAdminApplyDiscountCodeCommand,
  ): Promise<BillingAdminApplyDiscountCodeResult> {
    return this.runAsTrustedAdminBypass('apply-discount-code', async () => {
      const orderAmount = new Decimal(command.orderAmount);
      try {
        const applied = await this.discounts.apply(command.code, command.tenantId, orderAmount, {
          planId: command.planId,
          subscriptionChange: command.subscriptionChange,
          subscriptionId: command.subscriptionId,
          invoiceId: command.invoiceId,
          redeemedBy: command.actorId,
        });
        return {
          success: true,
          valid: true,
          originalAmount: applied.originalAmount.toString(),
          discountAmount: applied.discountAmount.toString(),
          finalAmount: applied.finalAmount.toString(),
          grantedFreeMonths: applied.grantedFreeMonths,
          grantedTrialExtensionDays: applied.grantedTrialExtensionDays,
          redemptionId: applied.redemptionId,
          message: applied.message,
        };
      } catch (err) {
        // A refused code is an ANSWER, not a transport failure: the order is
        // simply not discounted, and the caller shows the reason.
        if (err instanceof DiscountRejectedError) {
          return {
            success: true,
            valid: false,
            reason: err.reason,
            originalAmount: orderAmount.toString(),
            discountAmount: '0',
            finalAmount: orderAmount.toString(),
            message: err.message,
          };
        }
        const { errorCode, message } = this.mapError(err);
        this.logger.warn(`applyDiscountCode failed: code=${errorCode}, reason=${message}`);
        return { success: false, errorCode, error: message };
      }
    });
  }

  private toCommandError(operation: string, err: unknown): BillingAdminDiscountCodeCommandResult {
    const { errorCode, message } = this.mapError(err);
    this.logger.warn(`${operation} failed: code=${errorCode}, reason=${message}`);
    return { success: false, errorCode, error: message };
  }

  private mapError(err: unknown): { errorCode: BillingAdminCommandErrorCode; message: string } {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NotFoundException) return { errorCode: 'NOT_FOUND', message };
    if (err instanceof BadRequestException) return { errorCode: 'VALIDATION_ERROR', message };
    if (isConflict(err)) return { errorCode: 'CONFLICT', message };
    return { errorCode: 'INTERNAL_ERROR', message };
  }
}

function isConflict(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: unknown }).status === 409
  );
}
