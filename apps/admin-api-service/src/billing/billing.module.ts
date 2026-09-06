import { NatsV3Client } from '@aquaculture/backend-common/nats';
import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InvoiceReadOnly } from '../analytics/entities/external/invoice.entity';
import { Tenant } from '../tenant/entities/tenant.entity';

import { BillingController } from './billing.controller';
import {
  DiscountCodeReadOnly,
  DiscountRedemptionReadOnly,
} from './entities/external/discount-code.entity';
import {
  ModulePriceMetricReadOnly,
  ModulePriceReadOnly,
  ModulePriceTierMultiplierReadOnly,
} from './entities/external/module-price.entity';
import {
  CustomPlanLineItemReadOnly,
  CustomPlanModuleReadOnly,
  CustomPlanReadOnly,
} from './entities/external/custom-plan.entity';
import {
  PlanAddOnReadOnly,
  PlanCyclePriceReadOnly,
  PlanReadOnly,
} from './entities/external/plan.entity';
import { PlanModuleAssignment } from './entities/plan-module-assignment.entity';
import { UsageAggregationReadOnly } from './entities/usage-aggregation-readonly.entity';
import { BillingAdminCommandClientService } from './services/billing-admin-command-client.service';
import { CustomPlanService } from './services/custom-plan.service';
import { DiscountCodeService } from './services/discount-code.service';
import { InvoiceManagementService } from './services/invoice-management.service';
import { ModulePricingService } from './services/module-pricing.service';
import { PaymentManagementService } from './services/payment-management.service';
import { PlanDefinitionService } from './services/plan-definition.service';
import { SubscriptionAnalyticsService } from './services/subscription-analytics.service';
import { SubscriptionCoreService } from './services/subscription-core.service';
import { SubscriptionManagementService } from './services/subscription-management.service';
import { SubscriptionPlanChangeService } from './services/subscription-plan-change.service';
import { SubscriptionRenewalService } from './services/subscription-renewal.service';
import { UsageMeteringManagementService } from './services/usage-metering-management.service';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'BILLING_NATS_CLIENT',
        customClass: NatsV3Client,
        options: { serviceName: 'admin-api-service' },
      },
    ]),
    TypeOrmModule.forFeature([
      DiscountCodeReadOnly,
      DiscountRedemptionReadOnly,
      ModulePriceReadOnly,
      ModulePriceMetricReadOnly,
      ModulePriceTierMultiplierReadOnly,
      PlanReadOnly,
      PlanCyclePriceReadOnly,
      PlanAddOnReadOnly,
      PlanModuleAssignment,
      CustomPlanReadOnly,
      CustomPlanModuleReadOnly,
      CustomPlanLineItemReadOnly,
      InvoiceReadOnly,
      UsageAggregationReadOnly,
      Tenant,
    ]),
  ],
  controllers: [BillingController],
  providers: [
    PlanDefinitionService,
    DiscountCodeService,
    // Subscription services (SRP compliant)
    SubscriptionCoreService,
    SubscriptionPlanChangeService,
    SubscriptionRenewalService,
    SubscriptionAnalyticsService,
    // Facade for backward compatibility
    SubscriptionManagementService,
    ModulePricingService,
    CustomPlanService,
    InvoiceManagementService,
    PaymentManagementService,
    BillingAdminCommandClientService,
    UsageMeteringManagementService,
  ],
  exports: [
    PlanDefinitionService,
    DiscountCodeService,
    // Export both facade and individual services
    SubscriptionManagementService,
    SubscriptionCoreService,
    SubscriptionPlanChangeService,
    SubscriptionRenewalService,
    SubscriptionAnalyticsService,
    ModulePricingService,
    CustomPlanService,
    InvoiceManagementService,
    PaymentManagementService,
    BillingAdminCommandClientService,
    UsageMeteringManagementService,
  ],
})
export class BillingModule {}
