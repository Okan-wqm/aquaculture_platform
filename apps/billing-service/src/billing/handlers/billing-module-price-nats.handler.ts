/**
 * NATS request-reply surface for the module price sheet and its quotes
 * (ADR-0013, BILLING-CRITICAL-002).
 *
 * admin-api keeps the ModulePricing page and the quote UI; billing owns the
 * rows and the arithmetic. The quote in particular moved: admin used to fetch
 * the sheet, do the multiplication itself in floats, and send the result back
 * to billing as the priced module items of a provisioning command — so the
 * service that owns the prices trusted someone else's total.
 */
import {
  BadRequestException,
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
  type BillingAdminDeactivateModulePriceCommand,
  type BillingAdminModulePriceCommandResult,
  type BillingAdminQuoteModuleSelectionCommand,
  type BillingAdminQuoteModuleSelectionResult,
  type BillingAdminSeedModulePricesCommand,
  type BillingAdminSeedModulePricesResult,
  type BillingAdminSetModulePriceCommand,
} from '@platform/event-contracts';

import { ModulePricingService, toModulePriceSnapshot } from '../services/module-pricing.service';

import {
  BillingCommandReceiptInterceptor,
  NonMutatingBillingCommand,
} from '../interceptors/billing-command-receipt.interceptor';

@Controller()
@UseInterceptors(BillingCommandReceiptInterceptor)
export class BillingModulePriceNatsHandler {
  private readonly logger = new Logger(BillingModulePriceNatsHandler.name);

  constructor(
    private readonly modulePrices: ModulePricingService,
    private readonly bypassRls: BypassRlsService,
  ) {}

  /**
   * The price sheet is a cross-tenant catalogue with no tenant column, but the
   * quote reads `billing.discount_redemptions` to count a tenant's own
   * redemptions, and that table does carry the tenant policy. These commands
   * arrive with no HTTP request context, so the same audited bypass the other
   * admin handlers document applies here.
   */
  private async runAsTrustedAdminBypass<T>(operation: string, work: () => Promise<T>): Promise<T> {
    return this.bypassRls.withBypass(`billing-module-price:${operation}`, work);
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.SET_MODULE_PRICE)
  async setModulePrice(
    @Payload() command: BillingAdminSetModulePriceCommand,
  ): Promise<BillingAdminModulePriceCommandResult> {
    return this.runAsTrustedAdminBypass('set-module-price', async () => {
      try {
        const sheet = await this.modulePrices.setModulePrice(command.input, command.actorId);
        return { success: true, modulePrice: toModulePriceSnapshot(sheet) };
      } catch (err) {
        const { errorCode, message } = this.mapError(err);
        this.logger.warn(`setModulePrice failed: code=${errorCode}, reason=${message}`);
        return { success: false, errorCode, error: message };
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.DEACTIVATE_MODULE_PRICE)
  async deactivateModulePrice(
    @Payload() command: BillingAdminDeactivateModulePriceCommand,
  ): Promise<BillingAdminModulePriceCommandResult> {
    return this.runAsTrustedAdminBypass('deactivate-module-price', async () => {
      try {
        const sheet = await this.modulePrices.deactivate(command.modulePriceId, command.actorId);
        return { success: true, modulePrice: toModulePriceSnapshot(sheet) };
      } catch (err) {
        const { errorCode, message } = this.mapError(err);
        this.logger.warn(`deactivateModulePrice failed: code=${errorCode}, reason=${message}`);
        return { success: false, errorCode, error: message };
      }
    });
  }

  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.SEED_MODULE_PRICES)
  async seedModulePrices(
    @Payload() command: BillingAdminSeedModulePricesCommand,
  ): Promise<BillingAdminSeedModulePricesResult> {
    return this.runAsTrustedAdminBypass('seed-module-prices', async () => {
      try {
        const seeded = await this.modulePrices.seedDefaults(command.moduleIds, command.actorId);
        return { success: true, seeded };
      } catch (err) {
        const { errorCode, message } = this.mapError(err);
        this.logger.warn(`seedModulePrices failed: code=${errorCode}, reason=${message}`);
        return { success: false, errorCode, error: message };
      }
    });
  }

  // Pure arithmetic over the current price sheet. Replaying it would quote a
  // price the sheet no longer carries.
  @NonMutatingBillingCommand()
  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.QUOTE_MODULE_SELECTION)
  async quoteModuleSelection(
    @Payload() command: BillingAdminQuoteModuleSelectionCommand,
  ): Promise<BillingAdminQuoteModuleSelectionResult> {
    return this.runAsTrustedAdminBypass('quote-module-selection', async () => {
      try {
        return { success: true, quote: await this.modulePrices.quote(command) };
      } catch (err) {
        const { errorCode, message } = this.mapError(err);
        this.logger.warn(`quoteModuleSelection failed: code=${errorCode}, reason=${message}`);
        return { success: false, errorCode, error: message };
      }
    });
  }

  private mapError(err: unknown): { errorCode: BillingAdminCommandErrorCode; message: string } {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NotFoundException) return { errorCode: 'NOT_FOUND', message };
    if (err instanceof BadRequestException) return { errorCode: 'VALIDATION_ERROR', message };
    return { errorCode: 'INTERNAL_ERROR', message };
  }
}
