import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InvoiceReadOnly } from '../analytics/entities/external/invoice.entity';

import { BillingController } from './billing.controller';
import { CustomPlan } from './entities/custom-plan.entity';
import { DiscountCode, DiscountRedemption } from './entities/discount-code.entity';
import { ModulePricing } from './entities/module-pricing.entity';
import { PlanDefinition } from './entities/plan-definition.entity';
import { PlanModuleAssignment } from './entities/plan-module-assignment.entity';
import { CustomPlanService } from './services/custom-plan.service';
import { DiscountCodeService } from './services/discount-code.service';
import { InvoiceManagementService } from './services/invoice-management.service';
import { ModulePricingService } from './services/module-pricing.service';
import { PlanDefinitionService } from './services/plan-definition.service';
import { PricingCalculatorService } from './services/pricing-calculator.service';
import { SubscriptionAnalyticsService } from './services/subscription-analytics.service';
import { SubscriptionCoreService } from './services/subscription-core.service';
import { SubscriptionManagementService } from './services/subscription-management.service';
import { SubscriptionPlanChangeService } from './services/subscription-plan-change.service';
import { SubscriptionRenewalService } from './services/subscription-renewal.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlanDefinition,
      DiscountCode,
      DiscountRedemption,
      ModulePricing,
      PlanModuleAssignment,
      CustomPlan,
      InvoiceReadOnly,
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
    PricingCalculatorService,
    CustomPlanService,
    InvoiceManagementService,
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
    PricingCalculatorService,
    CustomPlanService,
    InvoiceManagementService,
  ],
})
export class BillingModule {}
