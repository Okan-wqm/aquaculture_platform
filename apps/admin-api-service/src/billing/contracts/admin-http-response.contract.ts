import { adminResponse, type AdminResponseProjection } from '@platform/admin-http-contracts';

export const billingPlanDefinitionContract = adminResponse.object({
  id: adminResponse.string(),
  code: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.optional(adminResponse.string()),
  shortDescription: adminResponse.optional(adminResponse.string()),
  tier: adminResponse.union([
    adminResponse.literal('free'),
    adminResponse.literal('starter'),
    adminResponse.literal('professional'),
    adminResponse.literal('enterprise'),
    adminResponse.literal('custom'),
  ] as const),
  visibility: adminResponse.union([
    adminResponse.literal('public'),
    adminResponse.literal('private'),
    adminResponse.literal('deprecated'),
  ] as const),
  isActive: adminResponse.boolean(),
  isRecommended: adminResponse.boolean(),
  sortOrder: adminResponse.number(),
  limits: adminResponse.object({
    maxUsers: adminResponse.number(),
    maxFarms: adminResponse.number(),
    maxPonds: adminResponse.number(),
    maxSensors: adminResponse.number(),
    maxModules: adminResponse.number(),
    storageGB: adminResponse.number(),
    dataRetentionDays: adminResponse.number(),
    apiRateLimit: adminResponse.number(),
    alertsEnabled: adminResponse.boolean(),
    reportsEnabled: adminResponse.boolean(),
    customBrandingEnabled: adminResponse.boolean(),
    apiAccessEnabled: adminResponse.boolean(),
    customIntegrationsEnabled: adminResponse.boolean(),
    ssoEnabled: adminResponse.boolean(),
    auditLogEnabled: adminResponse.boolean(),
    prioritySupport: adminResponse.boolean(),
    dedicatedAccountManager: adminResponse.boolean(),
  }),
  pricing: adminResponse.object({
    monthly: adminResponse.object({
      basePrice: adminResponse.number(),
      perUserPrice: adminResponse.number(),
      perFarmPrice: adminResponse.number(),
      perModulePrice: adminResponse.number(),
    }),
    quarterly: adminResponse.object({
      basePrice: adminResponse.number(),
      perUserPrice: adminResponse.number(),
      perFarmPrice: adminResponse.number(),
      perModulePrice: adminResponse.number(),
      discountPercent: adminResponse.number(),
    }),
    semiAnnual: adminResponse.object({
      basePrice: adminResponse.number(),
      perUserPrice: adminResponse.number(),
      perFarmPrice: adminResponse.number(),
      perModulePrice: adminResponse.number(),
      discountPercent: adminResponse.number(),
    }),
    annual: adminResponse.object({
      basePrice: adminResponse.number(),
      perUserPrice: adminResponse.number(),
      perFarmPrice: adminResponse.number(),
      perModulePrice: adminResponse.number(),
      discountPercent: adminResponse.number(),
    }),
    currency: adminResponse.string(),
  }),
  features: adminResponse.object({
    coreFeatures: adminResponse.array(adminResponse.string()),
    advancedFeatures: adminResponse.array(adminResponse.string()),
    premiumFeatures: adminResponse.array(adminResponse.string()),
    addOns: adminResponse.array(
      adminResponse.object({
        code: adminResponse.string(),
        name: adminResponse.string(),
        description: adminResponse.string(),
        price: adminResponse.number(),
        billingCycle: adminResponse.union([
          adminResponse.literal('monthly'),
          adminResponse.literal('quarterly'),
          adminResponse.literal('semi_annual'),
          adminResponse.literal('annual'),
        ] as const),
      }),
    ),
  }),
  trialDays: adminResponse.optional(adminResponse.number()),
  gracePeriodDays: adminResponse.optional(adminResponse.number()),
  upgradeMessage: adminResponse.optional(adminResponse.string()),
  downgradeWarning: adminResponse.optional(adminResponse.string()),
  stripeProductId: adminResponse.optional(adminResponse.string()),
  stripePriceIds: adminResponse.optional(adminResponse.record(adminResponse.string())),
  icon: adminResponse.optional(adminResponse.string()),
  color: adminResponse.optional(adminResponse.string()),
  badge: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
  createdBy: adminResponse.optional(adminResponse.string()),
  updatedBy: adminResponse.optional(adminResponse.string()),
});

export type BillingPlanDefinitionDto = AdminResponseProjection<
  typeof billingPlanDefinitionContract
>;

export const billingGetPlanByTierResponseContract = adminResponse.nullable(
  adminResponse.object({
    id: adminResponse.string(),
    code: adminResponse.string(),
    name: adminResponse.string(),
    description: adminResponse.optional(adminResponse.string()),
    shortDescription: adminResponse.optional(adminResponse.string()),
    tier: adminResponse.union([
      adminResponse.literal('free'),
      adminResponse.literal('starter'),
      adminResponse.literal('professional'),
      adminResponse.literal('enterprise'),
      adminResponse.literal('custom'),
    ] as const),
    visibility: adminResponse.union([
      adminResponse.literal('public'),
      adminResponse.literal('private'),
      adminResponse.literal('deprecated'),
    ] as const),
    isActive: adminResponse.boolean(),
    isRecommended: adminResponse.boolean(),
    sortOrder: adminResponse.number(),
    limits: adminResponse.object({
      maxUsers: adminResponse.number(),
      maxFarms: adminResponse.number(),
      maxPonds: adminResponse.number(),
      maxSensors: adminResponse.number(),
      maxModules: adminResponse.number(),
      storageGB: adminResponse.number(),
      dataRetentionDays: adminResponse.number(),
      apiRateLimit: adminResponse.number(),
      alertsEnabled: adminResponse.boolean(),
      reportsEnabled: adminResponse.boolean(),
      customBrandingEnabled: adminResponse.boolean(),
      apiAccessEnabled: adminResponse.boolean(),
      customIntegrationsEnabled: adminResponse.boolean(),
      ssoEnabled: adminResponse.boolean(),
      auditLogEnabled: adminResponse.boolean(),
      prioritySupport: adminResponse.boolean(),
      dedicatedAccountManager: adminResponse.boolean(),
    }),
    pricing: adminResponse.object({
      monthly: adminResponse.object({
        basePrice: adminResponse.number(),
        perUserPrice: adminResponse.number(),
        perFarmPrice: adminResponse.number(),
        perModulePrice: adminResponse.number(),
      }),
      quarterly: adminResponse.object({
        basePrice: adminResponse.number(),
        perUserPrice: adminResponse.number(),
        perFarmPrice: adminResponse.number(),
        perModulePrice: adminResponse.number(),
        discountPercent: adminResponse.number(),
      }),
      semiAnnual: adminResponse.object({
        basePrice: adminResponse.number(),
        perUserPrice: adminResponse.number(),
        perFarmPrice: adminResponse.number(),
        perModulePrice: adminResponse.number(),
        discountPercent: adminResponse.number(),
      }),
      annual: adminResponse.object({
        basePrice: adminResponse.number(),
        perUserPrice: adminResponse.number(),
        perFarmPrice: adminResponse.number(),
        perModulePrice: adminResponse.number(),
        discountPercent: adminResponse.number(),
      }),
      currency: adminResponse.string(),
    }),
    features: adminResponse.object({
      coreFeatures: adminResponse.array(adminResponse.string()),
      advancedFeatures: adminResponse.array(adminResponse.string()),
      premiumFeatures: adminResponse.array(adminResponse.string()),
      addOns: adminResponse.array(
        adminResponse.object({
          code: adminResponse.string(),
          name: adminResponse.string(),
          description: adminResponse.string(),
          price: adminResponse.number(),
          billingCycle: adminResponse.union([
            adminResponse.literal('monthly'),
            adminResponse.literal('quarterly'),
            adminResponse.literal('semi_annual'),
            adminResponse.literal('annual'),
          ] as const),
        }),
      ),
    }),
    trialDays: adminResponse.optional(adminResponse.number()),
    gracePeriodDays: adminResponse.optional(adminResponse.number()),
    upgradeMessage: adminResponse.optional(adminResponse.string()),
    downgradeWarning: adminResponse.optional(adminResponse.string()),
    stripeProductId: adminResponse.optional(adminResponse.string()),
    stripePriceIds: adminResponse.optional(adminResponse.record(adminResponse.string())),
    icon: adminResponse.optional(adminResponse.string()),
    color: adminResponse.optional(adminResponse.string()),
    badge: adminResponse.optional(adminResponse.string()),
    createdAt: adminResponse.dateString(),
    updatedAt: adminResponse.dateString(),
    createdBy: adminResponse.optional(adminResponse.string()),
    updatedBy: adminResponse.optional(adminResponse.string()),
  }),
);

export type BillingGetPlanByTierResponseDto = AdminResponseProjection<
  typeof billingGetPlanByTierResponseContract
>;

export const billingComparePlansResponseContract = adminResponse.object({
  isUpgrade: adminResponse.boolean(),
  isDowngrade: adminResponse.boolean(),
  priceDifference: adminResponse.number(),
  limitChanges: adminResponse.array(
    adminResponse.object({
      limit: adminResponse.string(),
      currentValue: adminResponse.number(),
      newValue: adminResponse.number(),
      change: adminResponse.union([
        adminResponse.literal('increase'),
        adminResponse.literal('decrease'),
        adminResponse.literal('same'),
      ] as const),
    }),
  ),
  featureChanges: adminResponse.array(
    adminResponse.object({
      feature: adminResponse.string(),
      gaining: adminResponse.boolean(),
    }),
  ),
  warnings: adminResponse.array(adminResponse.string()),
});

export type BillingComparePlansResponseDto = AdminResponseProjection<
  typeof billingComparePlansResponseContract
>;

export const billingPlanLimitsContract = adminResponse.object({
  maxUsers: adminResponse.number(),
  maxFarms: adminResponse.number(),
  maxPonds: adminResponse.number(),
  maxSensors: adminResponse.number(),
  maxModules: adminResponse.number(),
  storageGB: adminResponse.number(),
  dataRetentionDays: adminResponse.number(),
  apiRateLimit: adminResponse.number(),
  alertsEnabled: adminResponse.boolean(),
  reportsEnabled: adminResponse.boolean(),
  customBrandingEnabled: adminResponse.boolean(),
  apiAccessEnabled: adminResponse.boolean(),
  customIntegrationsEnabled: adminResponse.boolean(),
  ssoEnabled: adminResponse.boolean(),
  auditLogEnabled: adminResponse.boolean(),
  prioritySupport: adminResponse.boolean(),
  dedicatedAccountManager: adminResponse.boolean(),
});

export type BillingPlanLimitsDto = AdminResponseProjection<typeof billingPlanLimitsContract>;

export const billingSeedPlansResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
});

export type BillingSeedPlansResponseDto = AdminResponseProjection<
  typeof billingSeedPlansResponseContract
>;

export const billingDiscountCodeContract = adminResponse.object({
  id: adminResponse.string(),
  code: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.optional(adminResponse.string()),
  discountType: adminResponse.union([
    adminResponse.literal('percentage'),
    adminResponse.literal('fixed_amount'),
    adminResponse.literal('free_trial_extension'),
    adminResponse.literal('free_months'),
  ] as const),
  discountValue: adminResponse.number(),
  appliesTo: adminResponse.union([
    adminResponse.literal('all_plans'),
    adminResponse.literal('specific_plans'),
    adminResponse.literal('upgrades_only'),
    adminResponse.literal('new_subscriptions_only'),
  ] as const),
  applicablePlanIds: adminResponse.optional(adminResponse.array(adminResponse.string())),
  duration: adminResponse.union([
    adminResponse.literal('once'),
    adminResponse.literal('repeating'),
    adminResponse.literal('forever'),
  ] as const),
  durationInMonths: adminResponse.optional(adminResponse.number()),
  isActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  validFrom: adminResponse.optional(adminResponse.dateString()),
  validUntil: adminResponse.optional(adminResponse.dateString()),
  maxRedemptions: adminResponse.optional(adminResponse.number()),
  maxRedemptionsPerTenant: adminResponse.optional(adminResponse.number()),
  minimumOrderAmount: adminResponse.optional(adminResponse.number()),
  currentRedemptions: adminResponse.number(),
  campaignId: adminResponse.optional(adminResponse.string()),
  campaignName: adminResponse.optional(adminResponse.string()),
  stripePromotionCodeId: adminResponse.optional(adminResponse.string()),
  stripeCouponId: adminResponse.optional(adminResponse.string()),
  metadata: adminResponse.optional(
    adminResponse.record(adminResponse.json('extension-metadata')),
  ),
  isReferralCode: adminResponse.boolean(),
  referrerId: adminResponse.optional(adminResponse.string()),
  createdBy: adminResponse.optional(adminResponse.string()),
  updatedBy: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type BillingDiscountCodeDto = AdminResponseProjection<typeof billingDiscountCodeContract>;

export const billingDiscountStatsContract = adminResponse.object({
  totalCodes: adminResponse.number(),
  activeCodes: adminResponse.number(),
  expiredCodes: adminResponse.number(),
  totalRedemptions: adminResponse.number(),
  totalDiscountAmount: adminResponse.number(),
  topCodes: adminResponse.array(
    adminResponse.object({
      code: adminResponse.string(),
      redemptions: adminResponse.number(),
      totalDiscount: adminResponse.number(),
    }),
  ),
});

export type BillingDiscountStatsDto = AdminResponseProjection<typeof billingDiscountStatsContract>;

export const billingGetDiscountByCodeResponseContract = adminResponse.union([
  adminResponse.object({
    found: adminResponse.literal(false),
  }),
  adminResponse.object({
    found: adminResponse.literal(true),
    discount: billingDiscountCodeContract,
  }),
] as const);

export type BillingGetDiscountByCodeResponseDto = AdminResponseProjection<
  typeof billingGetDiscountByCodeResponseContract
>;

export const billingValidateDiscountCodeResponseContract = adminResponse.object({
  valid: adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
  discountCode: adminResponse.optional(billingDiscountCodeContract),
  discountAmount: adminResponse.optional(adminResponse.number()),
});

export type BillingValidateDiscountCodeResponseDto = AdminResponseProjection<
  typeof billingValidateDiscountCodeResponseContract
>;

export const billingApplyDiscountCodeResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  originalAmount: adminResponse.number(),
  discountAmount: adminResponse.number(),
  finalAmount: adminResponse.number(),
  redemptionId: adminResponse.optional(adminResponse.string()),
});

export type BillingApplyDiscountCodeResponseDto = AdminResponseProjection<
  typeof billingApplyDiscountCodeResponseContract
>;

export const billingGetDiscountRedemptionsResponseContract = adminResponse.object({
  redemptions: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      discountCodeId: adminResponse.string(),
      tenantId: adminResponse.string(),
      subscriptionId: adminResponse.optional(adminResponse.string()),
      invoiceId: adminResponse.optional(adminResponse.string()),
      discountAmount: adminResponse.number(),
      currency: adminResponse.string(),
      redeemedAt: adminResponse.dateString(),
      redeemedBy: adminResponse.optional(adminResponse.string()),
      createdAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type BillingGetDiscountRedemptionsResponseDto = AdminResponseProjection<
  typeof billingGetDiscountRedemptionsResponseContract
>;

export const billingGenerateUniqueCodeResponseContract = adminResponse.object({
  code: adminResponse.string(),
});

export type BillingGenerateUniqueCodeResponseDto = AdminResponseProjection<
  typeof billingGenerateUniqueCodeResponseContract
>;

export const billingBulkCreateDiscountCodesResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  count: adminResponse.number(),
  codes: adminResponse.array(billingDiscountCodeContract),
});

export type BillingBulkCreateDiscountCodesResponseDto = AdminResponseProjection<
  typeof billingBulkCreateDiscountCodesResponseContract
>;

export const neverResponseContract = adminResponse.never();

export type NeverResponseDto = AdminResponseProjection<typeof neverResponseContract>;

export const billingGetSubscriptionsResponseContract = adminResponse.object({
  subscriptions: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      tenantId: adminResponse.string(),
      tenantName: adminResponse.string(),
      planTier: adminResponse.string(),
      planName: adminResponse.string(),
      status: adminResponse.union([
        adminResponse.literal('trial'),
        adminResponse.literal('active'),
        adminResponse.literal('past_due'),
        adminResponse.literal('cancelled'),
        adminResponse.literal('suspended'),
        adminResponse.literal('expired'),
      ] as const),
      billingCycle: adminResponse.union([
        adminResponse.literal('monthly'),
        adminResponse.literal('quarterly'),
        adminResponse.literal('semi_annual'),
        adminResponse.literal('annual'),
      ] as const),
      currentPeriodStart: adminResponse.dateString(),
      currentPeriodEnd: adminResponse.dateString(),
      monthlyPrice: adminResponse.number(),
      autoRenew: adminResponse.union([
        adminResponse.literal(false),
        adminResponse.literal(true),
      ] as const),
      trialEndDate: adminResponse.optional(adminResponse.dateString()),
      cancelledAt: adminResponse.optional(adminResponse.dateString()),
      createdAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type BillingGetSubscriptionsResponseDto = AdminResponseProjection<
  typeof billingGetSubscriptionsResponseContract
>;

export const billingSubscriptionStatsContract = adminResponse.object({
  totalSubscriptions: adminResponse.number(),
  byStatus: adminResponse.object({
    trial: adminResponse.number(),
    active: adminResponse.number(),
    past_due: adminResponse.number(),
    cancelled: adminResponse.number(),
    suspended: adminResponse.number(),
    expired: adminResponse.number(),
  }),
  byPlanTier: adminResponse.record(adminResponse.number()),
  byBillingCycle: adminResponse.record(adminResponse.number()),
  mrr: adminResponse.number(),
  arr: adminResponse.number(),
  churnRate: adminResponse.number(),
  averageRevenuePerUser: adminResponse.number(),
  trialConversionRate: adminResponse.number(),
  expiringThisMonth: adminResponse.number(),
  pastDueCount: adminResponse.number(),
  totalRevenue: adminResponse.number(),
});

export type BillingSubscriptionStatsDto = AdminResponseProjection<
  typeof billingSubscriptionStatsContract
>;

export const billingGetSubscriptionsForRemindersResponseContract = adminResponse.object({
  upcomingDue: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      tenantId: adminResponse.string(),
      tenantName: adminResponse.string(),
      planTier: adminResponse.string(),
      planName: adminResponse.string(),
      status: adminResponse.union([
        adminResponse.literal('trial'),
        adminResponse.literal('active'),
        adminResponse.literal('past_due'),
        adminResponse.literal('cancelled'),
        adminResponse.literal('suspended'),
        adminResponse.literal('expired'),
      ] as const),
      billingCycle: adminResponse.union([
        adminResponse.literal('monthly'),
        adminResponse.literal('quarterly'),
        adminResponse.literal('semi_annual'),
        adminResponse.literal('annual'),
      ] as const),
      currentPeriodStart: adminResponse.dateString(),
      currentPeriodEnd: adminResponse.dateString(),
      monthlyPrice: adminResponse.number(),
      autoRenew: adminResponse.boolean(),
      trialEndDate: adminResponse.optional(adminResponse.dateString()),
      cancelledAt: adminResponse.optional(adminResponse.dateString()),
      createdAt: adminResponse.dateString(),
    }),
  ),
  pastDue: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      tenantId: adminResponse.string(),
      tenantName: adminResponse.string(),
      planTier: adminResponse.string(),
      planName: adminResponse.string(),
      status: adminResponse.union([
        adminResponse.literal('trial'),
        adminResponse.literal('active'),
        adminResponse.literal('past_due'),
        adminResponse.literal('cancelled'),
        adminResponse.literal('suspended'),
        adminResponse.literal('expired'),
      ] as const),
      billingCycle: adminResponse.union([
        adminResponse.literal('monthly'),
        adminResponse.literal('quarterly'),
        adminResponse.literal('semi_annual'),
        adminResponse.literal('annual'),
      ] as const),
      currentPeriodStart: adminResponse.dateString(),
      currentPeriodEnd: adminResponse.dateString(),
      monthlyPrice: adminResponse.number(),
      autoRenew: adminResponse.boolean(),
      trialEndDate: adminResponse.optional(adminResponse.dateString()),
      cancelledAt: adminResponse.optional(adminResponse.dateString()),
      createdAt: adminResponse.dateString(),
    }),
  ),
  gracePeriodEnding: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      tenantId: adminResponse.string(),
      tenantName: adminResponse.string(),
      planTier: adminResponse.string(),
      planName: adminResponse.string(),
      status: adminResponse.union([
        adminResponse.literal('trial'),
        adminResponse.literal('active'),
        adminResponse.literal('past_due'),
        adminResponse.literal('cancelled'),
        adminResponse.literal('suspended'),
        adminResponse.literal('expired'),
      ] as const),
      billingCycle: adminResponse.union([
        adminResponse.literal('monthly'),
        adminResponse.literal('quarterly'),
        adminResponse.literal('semi_annual'),
        adminResponse.literal('annual'),
      ] as const),
      currentPeriodStart: adminResponse.dateString(),
      currentPeriodEnd: adminResponse.dateString(),
      monthlyPrice: adminResponse.number(),
      autoRenew: adminResponse.boolean(),
      trialEndDate: adminResponse.optional(adminResponse.dateString()),
      cancelledAt: adminResponse.optional(adminResponse.dateString()),
      createdAt: adminResponse.dateString(),
    }),
  ),
});

export type BillingGetSubscriptionsForRemindersResponseDto = AdminResponseProjection<
  typeof billingGetSubscriptionsForRemindersResponseContract
>;

export const billingGetSubscriptionByTenantResponseContract = adminResponse.nullable(
  adminResponse.object({
    id: adminResponse.string(),
    tenantId: adminResponse.string(),
    tenantName: adminResponse.string(),
    planTier: adminResponse.string(),
    planName: adminResponse.string(),
    status: adminResponse.union([
      adminResponse.literal('trial'),
      adminResponse.literal('active'),
      adminResponse.literal('past_due'),
      adminResponse.literal('cancelled'),
      adminResponse.literal('suspended'),
      adminResponse.literal('expired'),
    ] as const),
    billingCycle: adminResponse.union([
      adminResponse.literal('monthly'),
      adminResponse.literal('quarterly'),
      adminResponse.literal('semi_annual'),
      adminResponse.literal('annual'),
    ] as const),
    currentPeriodStart: adminResponse.dateString(),
    currentPeriodEnd: adminResponse.dateString(),
    monthlyPrice: adminResponse.number(),
    autoRenew: adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    trialEndDate: adminResponse.optional(adminResponse.dateString()),
    cancelledAt: adminResponse.optional(adminResponse.dateString()),
    createdAt: adminResponse.dateString(),
  }),
);

export type BillingGetSubscriptionByTenantResponseDto = AdminResponseProjection<
  typeof billingGetSubscriptionByTenantResponseContract
>;

export const billingChangePlanResponseContract = adminResponse.object({
  success: adminResponse.boolean(),
  effectiveDate: adminResponse.optional(adminResponse.string()),
  newTrialEnd: adminResponse.optional(adminResponse.string()),
  message: adminResponse.optional(adminResponse.string()),
  errorCode: adminResponse.optional(
    adminResponse.union([
      adminResponse.literal('NOT_FOUND'),
      adminResponse.literal('VALIDATION_ERROR'),
      adminResponse.literal('CONFLICT'),
      adminResponse.literal('INTERNAL_ERROR'),
    ] as const),
  ),
  error: adminResponse.optional(adminResponse.string()),
});

export type BillingChangePlanResponseDto = AdminResponseProjection<
  typeof billingChangePlanResponseContract
>;

export const billingCancelSubscriptionResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
});

export type BillingCancelSubscriptionResponseDto = AdminResponseProjection<
  typeof billingCancelSubscriptionResponseContract
>;

export const billingReactivateSubscriptionResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
});

export type BillingReactivateSubscriptionResponseDto = AdminResponseProjection<
  typeof billingReactivateSubscriptionResponseContract
>;

export const billingExtendTrialResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  newTrialEnd: adminResponse.optional(adminResponse.string()),
});

export type BillingExtendTrialResponseDto = AdminResponseProjection<
  typeof billingExtendTrialResponseContract
>;

export const billingDiscountRedemptionContract = adminResponse.object({
  id: adminResponse.string(),
  discountCodeId: adminResponse.string(),
  tenantId: adminResponse.string(),
  subscriptionId: adminResponse.optional(adminResponse.string()),
  invoiceId: adminResponse.optional(adminResponse.string()),
  discountAmount: adminResponse.number(),
  currency: adminResponse.string(),
  redeemedAt: adminResponse.dateString(),
  redeemedBy: adminResponse.optional(adminResponse.string()),
  createdAt: adminResponse.dateString(),
});

export type BillingDiscountRedemptionDto = AdminResponseProjection<
  typeof billingDiscountRedemptionContract
>;

export const billingModulePricingContract = adminResponse.object({
  id: adminResponse.string(),
  moduleId: adminResponse.string(),
  moduleCode: adminResponse.string(),
  pricingMetrics: adminResponse.array(
    adminResponse.object({
      type: adminResponse.union([
        adminResponse.literal('base_price'),
        adminResponse.literal('per_user'),
        adminResponse.literal('per_farm'),
        adminResponse.literal('per_pond'),
        adminResponse.literal('per_sensor'),
        adminResponse.literal('per_device'),
        adminResponse.literal('per_gb_storage'),
        adminResponse.literal('per_gb_transfer'),
        adminResponse.literal('per_api_call'),
        adminResponse.literal('per_alert'),
        adminResponse.literal('per_report'),
        adminResponse.literal('per_sms'),
        adminResponse.literal('per_email'),
        adminResponse.literal('per_integration'),
        adminResponse.literal('per_workflow'),
      ] as const),
      price: adminResponse.number(),
      currency: adminResponse.string(),
      description: adminResponse.optional(adminResponse.string()),
      minQuantity: adminResponse.optional(adminResponse.number()),
      maxQuantity: adminResponse.optional(adminResponse.number()),
      includedQuantity: adminResponse.optional(adminResponse.number()),
    }),
  ),
  tierMultipliers: adminResponse.object({
    free: adminResponse.optional(adminResponse.number()),
    starter: adminResponse.optional(adminResponse.number()),
    professional: adminResponse.optional(adminResponse.number()),
    enterprise: adminResponse.optional(adminResponse.number()),
    custom: adminResponse.optional(adminResponse.number()),
  }),
  currency: adminResponse.string(),
  effectiveFrom: adminResponse.dateString(),
  effectiveTo: adminResponse.nullable(adminResponse.dateString()),
  isActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  notes: adminResponse.nullable(adminResponse.string()),
  version: adminResponse.number(),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type BillingModulePricingDto = AdminResponseProjection<typeof billingModulePricingContract>;

export const billingModulePricingWithModuleContract = adminResponse.object({
  moduleName: adminResponse.optional(adminResponse.string()),
  moduleDescription: adminResponse.optional(adminResponse.string()),
  moduleIcon: adminResponse.optional(adminResponse.string()),
  isModuleActive: adminResponse.optional(
    adminResponse.union([adminResponse.literal(false), adminResponse.literal(true)] as const),
  ),
  id: adminResponse.string(),
  moduleId: adminResponse.string(),
  moduleCode: adminResponse.string(),
  pricingMetrics: adminResponse.array(
    adminResponse.object({
      type: adminResponse.union([
        adminResponse.literal('base_price'),
        adminResponse.literal('per_user'),
        adminResponse.literal('per_farm'),
        adminResponse.literal('per_pond'),
        adminResponse.literal('per_sensor'),
        adminResponse.literal('per_device'),
        adminResponse.literal('per_gb_storage'),
        adminResponse.literal('per_gb_transfer'),
        adminResponse.literal('per_api_call'),
        adminResponse.literal('per_alert'),
        adminResponse.literal('per_report'),
        adminResponse.literal('per_sms'),
        adminResponse.literal('per_email'),
        adminResponse.literal('per_integration'),
        adminResponse.literal('per_workflow'),
      ] as const),
      price: adminResponse.number(),
      currency: adminResponse.string(),
      description: adminResponse.optional(adminResponse.string()),
      minQuantity: adminResponse.optional(adminResponse.number()),
      maxQuantity: adminResponse.optional(adminResponse.number()),
      includedQuantity: adminResponse.optional(adminResponse.number()),
    }),
  ),
  tierMultipliers: adminResponse.object({
    free: adminResponse.optional(adminResponse.number()),
    starter: adminResponse.optional(adminResponse.number()),
    professional: adminResponse.optional(adminResponse.number()),
    enterprise: adminResponse.optional(adminResponse.number()),
    custom: adminResponse.optional(adminResponse.number()),
  }),
  currency: adminResponse.string(),
  effectiveFrom: adminResponse.dateString(),
  effectiveTo: adminResponse.nullable(adminResponse.dateString()),
  isActive: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  notes: adminResponse.nullable(adminResponse.string()),
  version: adminResponse.number(),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type BillingModulePricingWithModuleDto = AdminResponseProjection<
  typeof billingModulePricingWithModuleContract
>;

export const billingGetModulePricingResponseContract = adminResponse.nullable(
  adminResponse.object({
    id: adminResponse.string(),
    moduleId: adminResponse.string(),
    moduleCode: adminResponse.string(),
    pricingMetrics: adminResponse.array(
      adminResponse.object({
        type: adminResponse.union([
          adminResponse.literal('base_price'),
          adminResponse.literal('per_user'),
          adminResponse.literal('per_farm'),
          adminResponse.literal('per_pond'),
          adminResponse.literal('per_sensor'),
          adminResponse.literal('per_device'),
          adminResponse.literal('per_gb_storage'),
          adminResponse.literal('per_gb_transfer'),
          adminResponse.literal('per_api_call'),
          adminResponse.literal('per_alert'),
          adminResponse.literal('per_report'),
          adminResponse.literal('per_sms'),
          adminResponse.literal('per_email'),
          adminResponse.literal('per_integration'),
          adminResponse.literal('per_workflow'),
        ] as const),
        price: adminResponse.number(),
        currency: adminResponse.string(),
        description: adminResponse.optional(adminResponse.string()),
        minQuantity: adminResponse.optional(adminResponse.number()),
        maxQuantity: adminResponse.optional(adminResponse.number()),
        includedQuantity: adminResponse.optional(adminResponse.number()),
      }),
    ),
    tierMultipliers: adminResponse.object({
      free: adminResponse.optional(adminResponse.number()),
      starter: adminResponse.optional(adminResponse.number()),
      professional: adminResponse.optional(adminResponse.number()),
      enterprise: adminResponse.optional(adminResponse.number()),
      custom: adminResponse.optional(adminResponse.number()),
    }),
    currency: adminResponse.string(),
    effectiveFrom: adminResponse.dateString(),
    effectiveTo: adminResponse.nullable(adminResponse.dateString()),
    isActive: adminResponse.boolean(),
    notes: adminResponse.nullable(adminResponse.string()),
    version: adminResponse.number(),
    createdAt: adminResponse.dateString(),
    updatedAt: adminResponse.dateString(),
    createdBy: adminResponse.nullable(adminResponse.string()),
    updatedBy: adminResponse.nullable(adminResponse.string()),
  }),
);

export type BillingGetModulePricingResponseDto = AdminResponseProjection<
  typeof billingGetModulePricingResponseContract
>;

export const billingGetModulePricingByCodeResponseContract = adminResponse.nullable(
  adminResponse.object({
    id: adminResponse.string(),
    moduleId: adminResponse.string(),
    moduleCode: adminResponse.string(),
    pricingMetrics: adminResponse.array(
      adminResponse.object({
        type: adminResponse.union([
          adminResponse.literal('base_price'),
          adminResponse.literal('per_user'),
          adminResponse.literal('per_farm'),
          adminResponse.literal('per_pond'),
          adminResponse.literal('per_sensor'),
          adminResponse.literal('per_device'),
          adminResponse.literal('per_gb_storage'),
          adminResponse.literal('per_gb_transfer'),
          adminResponse.literal('per_api_call'),
          adminResponse.literal('per_alert'),
          adminResponse.literal('per_report'),
          adminResponse.literal('per_sms'),
          adminResponse.literal('per_email'),
          adminResponse.literal('per_integration'),
          adminResponse.literal('per_workflow'),
        ] as const),
        price: adminResponse.number(),
        currency: adminResponse.string(),
        description: adminResponse.optional(adminResponse.string()),
        minQuantity: adminResponse.optional(adminResponse.number()),
        maxQuantity: adminResponse.optional(adminResponse.number()),
        includedQuantity: adminResponse.optional(adminResponse.number()),
      }),
    ),
    tierMultipliers: adminResponse.object({
      free: adminResponse.optional(adminResponse.number()),
      starter: adminResponse.optional(adminResponse.number()),
      professional: adminResponse.optional(adminResponse.number()),
      enterprise: adminResponse.optional(adminResponse.number()),
      custom: adminResponse.optional(adminResponse.number()),
    }),
    currency: adminResponse.string(),
    effectiveFrom: adminResponse.dateString(),
    effectiveTo: adminResponse.nullable(adminResponse.dateString()),
    isActive: adminResponse.union([
      adminResponse.literal(false),
      adminResponse.literal(true),
    ] as const),
    notes: adminResponse.nullable(adminResponse.string()),
    version: adminResponse.number(),
    createdAt: adminResponse.dateString(),
    updatedAt: adminResponse.dateString(),
  }),
);

export type BillingGetModulePricingByCodeResponseDto = AdminResponseProjection<
  typeof billingGetModulePricingByCodeResponseContract
>;

export const billingDeactivateModulePricingResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
});

export type BillingDeactivateModulePricingResponseDto = AdminResponseProjection<
  typeof billingDeactivateModulePricingResponseContract
>;

export const billingSeedModulePricingResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
  seededCount: adminResponse.number(),
});

export type BillingSeedModulePricingResponseDto = AdminResponseProjection<
  typeof billingSeedModulePricingResponseContract
>;

export const billingPricingCalculationContract = adminResponse.object({
  modules: adminResponse.array(
    adminResponse.object({
      moduleId: adminResponse.string(),
      moduleCode: adminResponse.string(),
      moduleName: adminResponse.string(),
      lineItems: adminResponse.array(
        adminResponse.object({
          metric: adminResponse.union([
            adminResponse.literal('base_price'),
            adminResponse.literal('per_user'),
            adminResponse.literal('per_farm'),
            adminResponse.literal('per_pond'),
            adminResponse.literal('per_sensor'),
            adminResponse.literal('per_device'),
            adminResponse.literal('per_gb_storage'),
            adminResponse.literal('per_gb_transfer'),
            adminResponse.literal('per_api_call'),
            adminResponse.literal('per_alert'),
            adminResponse.literal('per_report'),
            adminResponse.literal('per_sms'),
            adminResponse.literal('per_email'),
            adminResponse.literal('per_integration'),
            adminResponse.literal('per_workflow'),
          ] as const),
          metricLabel: adminResponse.string(),
          quantity: adminResponse.number(),
          includedQuantity: adminResponse.number(),
          billableQuantity: adminResponse.number(),
          unitPrice: adminResponse.number(),
          total: adminResponse.number(),
          tierMultiplier: adminResponse.number(),
        }),
      ),
      subtotal: adminResponse.number(),
      tierDiscount: adminResponse.number(),
      total: adminResponse.number(),
    }),
  ),
  subtotal: adminResponse.number(),
  tierDiscount: adminResponse.number(),
  discount: adminResponse.object({
    code: adminResponse.optional(adminResponse.string()),
    description: adminResponse.optional(adminResponse.string()),
    amount: adminResponse.number(),
    percent: adminResponse.number(),
  }),
  tax: adminResponse.number(),
  taxRate: adminResponse.number(),
  total: adminResponse.number(),
  monthlyTotal: adminResponse.number(),
  annualTotal: adminResponse.number(),
  billingCycle: adminResponse.union([
    adminResponse.literal('monthly'),
    adminResponse.literal('quarterly'),
    adminResponse.literal('semi_annual'),
    adminResponse.literal('annual'),
  ] as const),
  billingCycleMultiplier: adminResponse.number(),
  currency: adminResponse.string(),
  tier: adminResponse.union([
    adminResponse.literal('free'),
    adminResponse.literal('starter'),
    adminResponse.literal('professional'),
    adminResponse.literal('enterprise'),
    adminResponse.literal('custom'),
  ] as const),
  calculatedAt: adminResponse.dateString(),
});

export type BillingPricingCalculationDto = AdminResponseProjection<
  typeof billingPricingCalculationContract
>;

export const billingGetQuickEstimateResponseContract = adminResponse.object({
  monthlyTotal: adminResponse.number(),
  annualTotal: adminResponse.number(),
});

export type BillingGetQuickEstimateResponseDto = AdminResponseProjection<
  typeof billingGetQuickEstimateResponseContract
>;

export const billingPricingComparisonResultContract = adminResponse.object({
  config1: adminResponse.object({
    modules: adminResponse.array(
      adminResponse.object({
        moduleId: adminResponse.string(),
        moduleCode: adminResponse.string(),
        moduleName: adminResponse.string(),
        lineItems: adminResponse.array(
          adminResponse.object({
            metric: adminResponse.union([
              adminResponse.literal('base_price'),
              adminResponse.literal('per_user'),
              adminResponse.literal('per_farm'),
              adminResponse.literal('per_pond'),
              adminResponse.literal('per_sensor'),
              adminResponse.literal('per_device'),
              adminResponse.literal('per_gb_storage'),
              adminResponse.literal('per_gb_transfer'),
              adminResponse.literal('per_api_call'),
              adminResponse.literal('per_alert'),
              adminResponse.literal('per_report'),
              adminResponse.literal('per_sms'),
              adminResponse.literal('per_email'),
              adminResponse.literal('per_integration'),
              adminResponse.literal('per_workflow'),
            ] as const),
            metricLabel: adminResponse.string(),
            quantity: adminResponse.number(),
            includedQuantity: adminResponse.number(),
            billableQuantity: adminResponse.number(),
            unitPrice: adminResponse.number(),
            total: adminResponse.number(),
            tierMultiplier: adminResponse.number(),
          }),
        ),
        subtotal: adminResponse.number(),
        tierDiscount: adminResponse.number(),
        total: adminResponse.number(),
      }),
    ),
    subtotal: adminResponse.number(),
    tierDiscount: adminResponse.number(),
    discount: adminResponse.object({
      code: adminResponse.optional(adminResponse.string()),
      description: adminResponse.optional(adminResponse.string()),
      amount: adminResponse.number(),
      percent: adminResponse.number(),
    }),
    tax: adminResponse.number(),
    taxRate: adminResponse.number(),
    total: adminResponse.number(),
    monthlyTotal: adminResponse.number(),
    annualTotal: adminResponse.number(),
    billingCycle: adminResponse.union([
      adminResponse.literal('monthly'),
      adminResponse.literal('quarterly'),
      adminResponse.literal('semi_annual'),
      adminResponse.literal('annual'),
    ] as const),
    billingCycleMultiplier: adminResponse.number(),
    currency: adminResponse.string(),
    tier: adminResponse.union([
      adminResponse.literal('free'),
      adminResponse.literal('starter'),
      adminResponse.literal('professional'),
      adminResponse.literal('enterprise'),
      adminResponse.literal('custom'),
    ] as const),
    calculatedAt: adminResponse.dateString(),
  }),
  config2: adminResponse.object({
    modules: adminResponse.array(
      adminResponse.object({
        moduleId: adminResponse.string(),
        moduleCode: adminResponse.string(),
        moduleName: adminResponse.string(),
        lineItems: adminResponse.array(
          adminResponse.object({
            metric: adminResponse.union([
              adminResponse.literal('base_price'),
              adminResponse.literal('per_user'),
              adminResponse.literal('per_farm'),
              adminResponse.literal('per_pond'),
              adminResponse.literal('per_sensor'),
              adminResponse.literal('per_device'),
              adminResponse.literal('per_gb_storage'),
              adminResponse.literal('per_gb_transfer'),
              adminResponse.literal('per_api_call'),
              adminResponse.literal('per_alert'),
              adminResponse.literal('per_report'),
              adminResponse.literal('per_sms'),
              adminResponse.literal('per_email'),
              adminResponse.literal('per_integration'),
              adminResponse.literal('per_workflow'),
            ] as const),
            metricLabel: adminResponse.string(),
            quantity: adminResponse.number(),
            includedQuantity: adminResponse.number(),
            billableQuantity: adminResponse.number(),
            unitPrice: adminResponse.number(),
            total: adminResponse.number(),
            tierMultiplier: adminResponse.number(),
          }),
        ),
        subtotal: adminResponse.number(),
        tierDiscount: adminResponse.number(),
        total: adminResponse.number(),
      }),
    ),
    subtotal: adminResponse.number(),
    tierDiscount: adminResponse.number(),
    discount: adminResponse.object({
      code: adminResponse.optional(adminResponse.string()),
      description: adminResponse.optional(adminResponse.string()),
      amount: adminResponse.number(),
      percent: adminResponse.number(),
    }),
    tax: adminResponse.number(),
    taxRate: adminResponse.number(),
    total: adminResponse.number(),
    monthlyTotal: adminResponse.number(),
    annualTotal: adminResponse.number(),
    billingCycle: adminResponse.union([
      adminResponse.literal('monthly'),
      adminResponse.literal('quarterly'),
      adminResponse.literal('semi_annual'),
      adminResponse.literal('annual'),
    ] as const),
    billingCycleMultiplier: adminResponse.number(),
    currency: adminResponse.string(),
    tier: adminResponse.union([
      adminResponse.literal('free'),
      adminResponse.literal('starter'),
      adminResponse.literal('professional'),
      adminResponse.literal('enterprise'),
      adminResponse.literal('custom'),
    ] as const),
    calculatedAt: adminResponse.dateString(),
  }),
  difference: adminResponse.number(),
  percentDifference: adminResponse.number(),
  recommendation: adminResponse.string(),
});

export type BillingPricingComparisonResultDto = AdminResponseProjection<
  typeof billingPricingComparisonResultContract
>;

export const billingPaginatedCustomPlansContract = adminResponse.object({
  items: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      tenantId: adminResponse.string(),
      name: adminResponse.string(),
      description: adminResponse.nullable(adminResponse.string()),
      basePlanId: adminResponse.nullable(adminResponse.string()),
      tier: adminResponse.union([
        adminResponse.literal('free'),
        adminResponse.literal('starter'),
        adminResponse.literal('professional'),
        adminResponse.literal('enterprise'),
        adminResponse.literal('custom'),
      ] as const),
      billingCycle: adminResponse.union([
        adminResponse.literal('monthly'),
        adminResponse.literal('quarterly'),
        adminResponse.literal('semi_annual'),
        adminResponse.literal('annual'),
      ] as const),
      modules: adminResponse.array(
        adminResponse.object({
          moduleId: adminResponse.string(),
          moduleCode: adminResponse.string(),
          moduleName: adminResponse.string(),
          quantities: adminResponse.object({
            users: adminResponse.optional(adminResponse.number()),
            farms: adminResponse.optional(adminResponse.number()),
            ponds: adminResponse.optional(adminResponse.number()),
            sensors: adminResponse.optional(adminResponse.number()),
            devices: adminResponse.optional(adminResponse.number()),
            storageGb: adminResponse.optional(adminResponse.number()),
            apiCalls: adminResponse.optional(adminResponse.number()),
            alerts: adminResponse.optional(adminResponse.number()),
            reports: adminResponse.optional(adminResponse.number()),
            integrations: adminResponse.optional(adminResponse.number()),
          }),
          lineItems: adminResponse.array(
            adminResponse.object({
              metric: adminResponse.string(),
              description: adminResponse.string(),
              quantity: adminResponse.number(),
              unitPrice: adminResponse.number(),
              total: adminResponse.number(),
            }),
          ),
          subtotal: adminResponse.number(),
        }),
      ),
      monthlySubtotal: adminResponse.number(),
      discountPercent: adminResponse.number(),
      discountAmount: adminResponse.number(),
      discountReason: adminResponse.nullable(adminResponse.string()),
      monthlyTotal: adminResponse.number(),
      currency: adminResponse.string(),
      status: adminResponse.union([
        adminResponse.literal('draft'),
        adminResponse.literal('pending_approval'),
        adminResponse.literal('approved'),
        adminResponse.literal('active'),
        adminResponse.literal('expired'),
        adminResponse.literal('rejected'),
      ] as const),
      validFrom: adminResponse.dateString(),
      validTo: adminResponse.nullable(adminResponse.dateString()),
      notes: adminResponse.nullable(adminResponse.string()),
      approvedBy: adminResponse.nullable(adminResponse.string()),
      approvedAt: adminResponse.nullable(adminResponse.dateString()),
      rejectionReason: adminResponse.nullable(adminResponse.string()),
      subscriptionId: adminResponse.nullable(adminResponse.string()),
      createdBy: adminResponse.nullable(adminResponse.string()),
      updatedBy: adminResponse.nullable(adminResponse.string()),
      createdAt: adminResponse.dateString(),
      updatedAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
  page: adminResponse.number(),
  limit: adminResponse.number(),
  totalPages: adminResponse.number(),
});

export type BillingPaginatedCustomPlansDto = AdminResponseProjection<
  typeof billingPaginatedCustomPlansContract
>;

export const billingCustomPlanContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  name: adminResponse.string(),
  description: adminResponse.nullable(adminResponse.string()),
  basePlanId: adminResponse.nullable(adminResponse.string()),
  tier: adminResponse.union([
    adminResponse.literal('free'),
    adminResponse.literal('starter'),
    adminResponse.literal('professional'),
    adminResponse.literal('enterprise'),
    adminResponse.literal('custom'),
  ] as const),
  billingCycle: adminResponse.union([
    adminResponse.literal('monthly'),
    adminResponse.literal('quarterly'),
    adminResponse.literal('semi_annual'),
    adminResponse.literal('annual'),
  ] as const),
  modules: adminResponse.array(
    adminResponse.object({
      moduleId: adminResponse.string(),
      moduleCode: adminResponse.string(),
      moduleName: adminResponse.string(),
      quantities: adminResponse.object({
        users: adminResponse.optional(adminResponse.number()),
        farms: adminResponse.optional(adminResponse.number()),
        ponds: adminResponse.optional(adminResponse.number()),
        sensors: adminResponse.optional(adminResponse.number()),
        devices: adminResponse.optional(adminResponse.number()),
        storageGb: adminResponse.optional(adminResponse.number()),
        apiCalls: adminResponse.optional(adminResponse.number()),
        alerts: adminResponse.optional(adminResponse.number()),
        reports: adminResponse.optional(adminResponse.number()),
        integrations: adminResponse.optional(adminResponse.number()),
      }),
      lineItems: adminResponse.array(
        adminResponse.object({
          metric: adminResponse.string(),
          description: adminResponse.string(),
          quantity: adminResponse.number(),
          unitPrice: adminResponse.number(),
          total: adminResponse.number(),
        }),
      ),
      subtotal: adminResponse.number(),
    }),
  ),
  monthlySubtotal: adminResponse.number(),
  discountPercent: adminResponse.number(),
  discountAmount: adminResponse.number(),
  discountReason: adminResponse.nullable(adminResponse.string()),
  monthlyTotal: adminResponse.number(),
  currency: adminResponse.string(),
  status: adminResponse.union([
    adminResponse.literal('draft'),
    adminResponse.literal('pending_approval'),
    adminResponse.literal('approved'),
    adminResponse.literal('active'),
    adminResponse.literal('expired'),
    adminResponse.literal('rejected'),
  ] as const),
  validFrom: adminResponse.dateString(),
  validTo: adminResponse.nullable(adminResponse.dateString()),
  notes: adminResponse.nullable(adminResponse.string()),
  approvedBy: adminResponse.nullable(adminResponse.string()),
  approvedAt: adminResponse.nullable(adminResponse.dateString()),
  rejectionReason: adminResponse.nullable(adminResponse.string()),
  subscriptionId: adminResponse.nullable(adminResponse.string()),
  createdBy: adminResponse.nullable(adminResponse.string()),
  updatedBy: adminResponse.nullable(adminResponse.string()),
  createdAt: adminResponse.dateString(),
  updatedAt: adminResponse.dateString(),
});

export type BillingCustomPlanDto = AdminResponseProjection<typeof billingCustomPlanContract>;

export const billingGetCustomPlanByTenantResponseContract = adminResponse.nullable(
  adminResponse.object({
    id: adminResponse.string(),
    tenantId: adminResponse.string(),
    name: adminResponse.string(),
    description: adminResponse.nullable(adminResponse.string()),
    basePlanId: adminResponse.nullable(adminResponse.string()),
    tier: adminResponse.union([
      adminResponse.literal('free'),
      adminResponse.literal('starter'),
      adminResponse.literal('professional'),
      adminResponse.literal('enterprise'),
      adminResponse.literal('custom'),
    ] as const),
    billingCycle: adminResponse.union([
      adminResponse.literal('monthly'),
      adminResponse.literal('quarterly'),
      adminResponse.literal('semi_annual'),
      adminResponse.literal('annual'),
    ] as const),
    modules: adminResponse.array(
      adminResponse.object({
        moduleId: adminResponse.string(),
        moduleCode: adminResponse.string(),
        moduleName: adminResponse.string(),
        quantities: adminResponse.object({
          users: adminResponse.optional(adminResponse.number()),
          farms: adminResponse.optional(adminResponse.number()),
          ponds: adminResponse.optional(adminResponse.number()),
          sensors: adminResponse.optional(adminResponse.number()),
          devices: adminResponse.optional(adminResponse.number()),
          storageGb: adminResponse.optional(adminResponse.number()),
          apiCalls: adminResponse.optional(adminResponse.number()),
          alerts: adminResponse.optional(adminResponse.number()),
          reports: adminResponse.optional(adminResponse.number()),
          integrations: adminResponse.optional(adminResponse.number()),
        }),
        lineItems: adminResponse.array(
          adminResponse.object({
            metric: adminResponse.string(),
            description: adminResponse.string(),
            quantity: adminResponse.number(),
            unitPrice: adminResponse.number(),
            total: adminResponse.number(),
          }),
        ),
        subtotal: adminResponse.number(),
      }),
    ),
    monthlySubtotal: adminResponse.number(),
    discountPercent: adminResponse.number(),
    discountAmount: adminResponse.number(),
    discountReason: adminResponse.nullable(adminResponse.string()),
    monthlyTotal: adminResponse.number(),
    currency: adminResponse.string(),
    status: adminResponse.union([
      adminResponse.literal('draft'),
      adminResponse.literal('pending_approval'),
      adminResponse.literal('approved'),
      adminResponse.literal('active'),
      adminResponse.literal('expired'),
      adminResponse.literal('rejected'),
    ] as const),
    validFrom: adminResponse.dateString(),
    validTo: adminResponse.nullable(adminResponse.dateString()),
    notes: adminResponse.nullable(adminResponse.string()),
    approvedBy: adminResponse.nullable(adminResponse.string()),
    approvedAt: adminResponse.nullable(adminResponse.dateString()),
    rejectionReason: adminResponse.nullable(adminResponse.string()),
    subscriptionId: adminResponse.nullable(adminResponse.string()),
    createdBy: adminResponse.nullable(adminResponse.string()),
    updatedBy: adminResponse.nullable(adminResponse.string()),
    createdAt: adminResponse.dateString(),
    updatedAt: adminResponse.dateString(),
  }),
);

export type BillingGetCustomPlanByTenantResponseDto = AdminResponseProjection<
  typeof billingGetCustomPlanByTenantResponseContract
>;

export const billingDeleteCustomPlanResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
});

export type BillingDeleteCustomPlanResponseDto = AdminResponseProjection<
  typeof billingDeleteCustomPlanResponseContract
>;

export const billingGetInvoicesResponseContract = adminResponse.object({
  invoices: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      invoiceNumber: adminResponse.string(),
      tenantId: adminResponse.string(),
      tenantName: adminResponse.string(),
      tenantEmail: adminResponse.optional(adminResponse.string()),
      amount: adminResponse.number(),
      amountPaid: adminResponse.number(),
      amountDue: adminResponse.number(),
      status: adminResponse.union([
        adminResponse.literal('draft'),
        adminResponse.literal('pending'),
        adminResponse.literal('sent'),
        adminResponse.literal('paid'),
        adminResponse.literal('partially_paid'),
        adminResponse.literal('overdue'),
        adminResponse.literal('void'),
        adminResponse.literal('refunded'),
      ] as const),
      currency: adminResponse.string(),
      dueDate: adminResponse.dateString(),
      paidAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
      issueDate: adminResponse.dateString(),
      periodStart: adminResponse.dateString(),
      periodEnd: adminResponse.dateString(),
      createdAt: adminResponse.dateString(),
    }),
  ),
  total: adminResponse.number(),
});

export type BillingGetInvoicesResponseDto = AdminResponseProjection<
  typeof billingGetInvoicesResponseContract
>;

export const billingInvoiceStatsContract = adminResponse.object({
  totalInvoices: adminResponse.number(),
  totalAmount: adminResponse.number(),
  totalPaid: adminResponse.number(),
  totalPending: adminResponse.number(),
  totalOverdue: adminResponse.number(),
  byStatus: adminResponse.record(
    adminResponse.object({
      count: adminResponse.number(),
      amount: adminResponse.number(),
    }),
  ),
  byCurrency: adminResponse.record(adminResponse.number()),
  avgPaymentTime: adminResponse.number(),
  overdueRate: adminResponse.number(),
  paidThisMonth: adminResponse.number(),
  pendingThisMonth: adminResponse.number(),
});

export type BillingInvoiceStatsDto = AdminResponseProjection<typeof billingInvoiceStatsContract>;

export const billingInvoiceOverviewContract = adminResponse.object({
  id: adminResponse.string(),
  invoiceNumber: adminResponse.string(),
  tenantId: adminResponse.string(),
  tenantName: adminResponse.string(),
  tenantEmail: adminResponse.optional(adminResponse.string()),
  amount: adminResponse.number(),
  amountPaid: adminResponse.number(),
  amountDue: adminResponse.number(),
  status: adminResponse.union([
    adminResponse.literal('draft'),
    adminResponse.literal('pending'),
    adminResponse.literal('sent'),
    adminResponse.literal('paid'),
    adminResponse.literal('partially_paid'),
    adminResponse.literal('overdue'),
    adminResponse.literal('void'),
    adminResponse.literal('refunded'),
  ] as const),
  currency: adminResponse.string(),
  dueDate: adminResponse.dateString(),
  paidAt: adminResponse.optional(adminResponse.nullable(adminResponse.dateString())),
  issueDate: adminResponse.dateString(),
  periodStart: adminResponse.dateString(),
  periodEnd: adminResponse.dateString(),
  createdAt: adminResponse.dateString(),
});

export type BillingInvoiceOverviewDto = AdminResponseProjection<
  typeof billingInvoiceOverviewContract
>;

export const billingBillingAdminInvoiceResultContract = adminResponse.object({
  id: adminResponse.string(),
  invoiceNumber: adminResponse.string(),
  tenantId: adminResponse.string(),
  subscriptionId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  amount: adminResponse.number(),
  amountPaid: adminResponse.number(),
  amountDue: adminResponse.number(),
  status: adminResponse.string(),
  currency: adminResponse.string(),
  dueDate: adminResponse.string(),
  paidAt: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  issueDate: adminResponse.string(),
  periodStart: adminResponse.string(),
  periodEnd: adminResponse.string(),
  createdAt: adminResponse.string(),
  updatedAt: adminResponse.string(),
});

export type BillingBillingAdminInvoiceResultDto = AdminResponseProjection<
  typeof billingBillingAdminInvoiceResultContract
>;

export const billingMarkInvoiceAsPaidResponseContract = adminResponse.object({
  success: adminResponse.boolean(),
  invoice: adminResponse.object({
    id: adminResponse.string(),
    invoiceNumber: adminResponse.string(),
    tenantId: adminResponse.string(),
    subscriptionId: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
    amount: adminResponse.number(),
    amountPaid: adminResponse.number(),
    amountDue: adminResponse.number(),
    status: adminResponse.string(),
    currency: adminResponse.string(),
    dueDate: adminResponse.string(),
    paidAt: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
    issueDate: adminResponse.string(),
    periodStart: adminResponse.string(),
    periodEnd: adminResponse.string(),
    createdAt: adminResponse.string(),
    updatedAt: adminResponse.string(),
  }),
});

export type BillingMarkInvoiceAsPaidResponseDto = AdminResponseProjection<
  typeof billingMarkInvoiceAsPaidResponseContract
>;

export const billingVoidInvoiceResponseContract = adminResponse.object({
  success: adminResponse.union([
    adminResponse.literal(false),
    adminResponse.literal(true),
  ] as const),
});

export type BillingVoidInvoiceResponseDto = AdminResponseProjection<
  typeof billingVoidInvoiceResponseContract
>;

export const billingGetPaymentsResponseContract = adminResponse.object({
  payments: adminResponse.array(
    adminResponse.object({
      id: adminResponse.string(),
      tenantId: adminResponse.string(),
      transactionId: adminResponse.string(),
      invoiceId: adminResponse.string(),
      invoiceNumber: adminResponse.optional(adminResponse.string()),
      tenantName: adminResponse.optional(adminResponse.string()),
      amount: adminResponse.number(),
      currency: adminResponse.string(),
      status: adminResponse.string(),
      paymentMethod: adminResponse.string(),
      paymentDate: adminResponse.string(),
      processedAt: adminResponse.optional(adminResponse.string()),
      failureReason: adminResponse.optional(adminResponse.string()),
      refundedAmount: adminResponse.number(),
      notes: adminResponse.optional(adminResponse.string()),
      createdAt: adminResponse.string(),
      updatedAt: adminResponse.string(),
      createdBy: adminResponse.optional(adminResponse.string()),
    }),
  ),
  total: adminResponse.number(),
});

export type BillingGetPaymentsResponseDto = AdminResponseProjection<
  typeof billingGetPaymentsResponseContract
>;

export const billingBillingAdminPaymentResultContract = adminResponse.object({
  id: adminResponse.string(),
  tenantId: adminResponse.string(),
  transactionId: adminResponse.string(),
  invoiceId: adminResponse.string(),
  amount: adminResponse.number(),
  currency: adminResponse.string(),
  status: adminResponse.string(),
  paymentMethod: adminResponse.string(),
  paymentDate: adminResponse.string(),
  processedAt: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  failureReason: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  refundedAmount: adminResponse.number(),
  notes: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
  createdAt: adminResponse.string(),
  updatedAt: adminResponse.string(),
  createdBy: adminResponse.optional(adminResponse.nullable(adminResponse.string())),
});

export type BillingBillingAdminPaymentResultDto = AdminResponseProjection<
  typeof billingBillingAdminPaymentResultContract
>;

export const billingUsageSummaryStatsContract = adminResponse.object({
  totalTenants: adminResponse.number(),
  totalEvents: adminResponse.number(),
  meterBreakdown: adminResponse.array(
    adminResponse.object({
      meterType: adminResponse.union([
        adminResponse.literal('api_calls'),
        adminResponse.literal('data_storage'),
        adminResponse.literal('sensor_readings'),
        adminResponse.literal('alerts_sent'),
        adminResponse.literal('reports_generated'),
        adminResponse.literal('users_active'),
        adminResponse.literal('farms_active'),
        adminResponse.literal('ponds_active'),
        adminResponse.literal('sensors_active'),
        adminResponse.literal('data_export'),
        adminResponse.literal('integrations'),
        adminResponse.literal('custom'),
      ] as const),
      totalUsage: adminResponse.number(),
      avgPerTenant: adminResponse.number(),
      maxPerTenant: adminResponse.number(),
      unit: adminResponse.string(),
      tenantCount: adminResponse.number(),
    }),
  ),
  periodCovered: adminResponse.object({
    from: adminResponse.dateString(),
    to: adminResponse.dateString(),
  }),
});

export type BillingUsageSummaryStatsDto = AdminResponseProjection<
  typeof billingUsageSummaryStatsContract
>;

export const billingGetAllTenantsUsageResponseContract = adminResponse.object({
  tenants: adminResponse.array(
    adminResponse.object({
      tenantId: adminResponse.string(),
      tenantName: adminResponse.optional(adminResponse.string()),
      meters: adminResponse.array(
        adminResponse.object({
          meterType: adminResponse.union([
            adminResponse.literal('api_calls'),
            adminResponse.literal('data_storage'),
            adminResponse.literal('sensor_readings'),
            adminResponse.literal('alerts_sent'),
            adminResponse.literal('reports_generated'),
            adminResponse.literal('users_active'),
            adminResponse.literal('farms_active'),
            adminResponse.literal('ponds_active'),
            adminResponse.literal('sensors_active'),
            adminResponse.literal('data_export'),
            adminResponse.literal('integrations'),
            adminResponse.literal('custom'),
          ] as const),
          totalUsage: adminResponse.number(),
          unit: adminResponse.string(),
          eventCount: adminResponse.number(),
          peakUsage: adminResponse.number(),
          averageUsage: adminResponse.number(),
        }),
      ),
      totalEvents: adminResponse.number(),
      lastActivity: adminResponse.optional(adminResponse.dateString()),
    }),
  ),
  total: adminResponse.number(),
});

export type BillingGetAllTenantsUsageResponseDto = AdminResponseProjection<
  typeof billingGetAllTenantsUsageResponseContract
>;

export const billingTenantUsageOverviewContract = adminResponse.object({
  tenantId: adminResponse.string(),
  tenantName: adminResponse.optional(adminResponse.string()),
  meters: adminResponse.array(
    adminResponse.object({
      meterType: adminResponse.union([
        adminResponse.literal('api_calls'),
        adminResponse.literal('data_storage'),
        adminResponse.literal('sensor_readings'),
        adminResponse.literal('alerts_sent'),
        adminResponse.literal('reports_generated'),
        adminResponse.literal('users_active'),
        adminResponse.literal('farms_active'),
        adminResponse.literal('ponds_active'),
        adminResponse.literal('sensors_active'),
        adminResponse.literal('data_export'),
        adminResponse.literal('integrations'),
        adminResponse.literal('custom'),
      ] as const),
      totalUsage: adminResponse.number(),
      unit: adminResponse.string(),
      eventCount: adminResponse.number(),
      peakUsage: adminResponse.number(),
      averageUsage: adminResponse.number(),
    }),
  ),
  totalEvents: adminResponse.number(),
  lastActivity: adminResponse.optional(adminResponse.dateString()),
});

export type BillingTenantUsageOverviewDto = AdminResponseProjection<
  typeof billingTenantUsageOverviewContract
>;

export const billingUsageTrendPointContract = adminResponse.object({
  periodStart: adminResponse.dateString(),
  periodEnd: adminResponse.dateString(),
  meterType: adminResponse.union([
    adminResponse.literal('api_calls'),
    adminResponse.literal('data_storage'),
    adminResponse.literal('sensor_readings'),
    adminResponse.literal('alerts_sent'),
    adminResponse.literal('reports_generated'),
    adminResponse.literal('users_active'),
    adminResponse.literal('farms_active'),
    adminResponse.literal('ponds_active'),
    adminResponse.literal('sensors_active'),
    adminResponse.literal('data_export'),
    adminResponse.literal('integrations'),
    adminResponse.literal('custom'),
  ] as const),
  totalUsage: adminResponse.number(),
  peakUsage: adminResponse.number(),
  averageUsage: adminResponse.number(),
  eventCount: adminResponse.number(),
  unit: adminResponse.string(),
});

export type BillingUsageTrendPointDto = AdminResponseProjection<
  typeof billingUsageTrendPointContract
>;

export const billingTopTenantUsageContract = adminResponse.object({
  tenantId: adminResponse.string(),
  tenantName: adminResponse.optional(adminResponse.string()),
  totalUsage: adminResponse.number(),
  meterType: adminResponse.union([
    adminResponse.literal('api_calls'),
    adminResponse.literal('data_storage'),
    adminResponse.literal('sensor_readings'),
    adminResponse.literal('alerts_sent'),
    adminResponse.literal('reports_generated'),
    adminResponse.literal('users_active'),
    adminResponse.literal('farms_active'),
    adminResponse.literal('ponds_active'),
    adminResponse.literal('sensors_active'),
    adminResponse.literal('data_export'),
    adminResponse.literal('integrations'),
    adminResponse.literal('custom'),
  ] as const),
  unit: adminResponse.string(),
  eventCount: adminResponse.number(),
});

export type BillingTopTenantUsageDto = AdminResponseProjection<
  typeof billingTopTenantUsageContract
>;

export const billingPlanDefinitionArrayContract = adminResponse.array(
  billingPlanDefinitionContract,
);

export const billingDiscountCodePageContract = adminResponse.page(billingDiscountCodeContract);

export const billingDiscountRedemptionPageContract = adminResponse.page(
  billingDiscountRedemptionContract,
);

export const billingInvoiceOverviewArrayContract = adminResponse.array(
  billingInvoiceOverviewContract,
);

export const billingModulePricingArrayContract = adminResponse.array(billingModulePricingContract);

export const billingModulePricingPageContract = adminResponse.page(billingModulePricingContract);

export const billingModulePricingWithModuleArrayContract = adminResponse.array(
  billingModulePricingWithModuleContract,
);

export const billingTopTenantUsageArrayContract = adminResponse.array(
  billingTopTenantUsageContract,
);

export const billingUsageTrendPointArrayContract = adminResponse.array(
  billingUsageTrendPointContract,
);
