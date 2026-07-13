/**
 * GraphQL queries for billing, activity, audit logs, subscription,
 * and notification preferences.
 */

// ============================================================================
// Billing
// ============================================================================

export const TENANT_BILLING_QUERY = `
  query TenantBilling {
    tenantBilling {
      subscription {
        id
        plan
        status
        billingPeriod
        currentPeriodStart
        currentPeriodEnd
        trialEndDate
        monthlyPrice
        monthlyPriceDecimal
        currency
      }
      invoices {
        id
        invoiceNumber
        amount
        amountDecimal
        currency
        status
        issuedAt
        dueDate
        paidAt
        description
      }
      planLimits {
        maxFarms
        maxSensors
        maxUsers
        maxStorage
        currentFarms
        currentSensors
        currentUsers
        currentStorage
      }
      usageMetrics {
        apiCallsThisMonth
        apiCallsLimit
        storageUsedGb
        storageLimit
        sensorReadingsThisMonth
        sensorReadingsLimit
      }
    }
  }
`;

// ============================================================================
// Subscription (Dashboard)
// ============================================================================

export const MY_SUBSCRIPTION_QUERY = `
  query MySubscription {
    subscription {
      id
      status
      planTier
      planName
      billingCycle
      currentPeriodStart
      currentPeriodEnd
      trialEndDate
      pricing {
        basePrice
        basePriceDecimal
        currency
      }
    }
  }
`;

// ============================================================================
// Activity
// ============================================================================

export const TENANT_ACTIVITY_QUERY = `
  query TenantActivity($period: String) {
    tenantActivity(period: $period) {
      recentLogins {
        id
        userId
        email
        firstName
        lastName
        loginAt
        ipAddress
        userAgent
        deviceType
        success
      }
      activeSessions
      userActivitySummaries {
        userId
        email
        firstName
        lastName
        totalActions
        lastActiveAt
        loginCount
      }
      dailyActiveUsers {
        date
        count
      }
    }
  }
`;

// ============================================================================
// Audit Logs
// ============================================================================

export const TENANT_AUDIT_LOGS_QUERY = `
  query TenantAuditLogs(
    $startDate: String
    $endDate: String
    $action: String
    $severity: String
    $performedBy: String
    $limit: Int
    $offset: Int
  ) {
    tenantAuditLogs(
      startDate: $startDate
      endDate: $endDate
      action: $action
      severity: $severity
      performedBy: $performedBy
      limit: $limit
      offset: $offset
    ) {
      data {
        id
        performedBy
        performedByEmail
        action
        entityType
        entityId
        details
        severity
        ipAddress
        userAgent
        createdAt
      }
      total
    }
  }
`;

// ============================================================================
// Notification Preferences
// ============================================================================

export const GET_NOTIFICATION_PREFERENCES_QUERY = `
  query GetMyNotificationPreferences {
    getMyNotificationPreferences {
      emailEnabled
      smsEnabled
      pushEnabled
      quietHoursStart
      quietHoursEnd
      quietHoursTimezone
      alertNotifications
      taskNotifications
      systemNotifications
    }
  }
`;

export const UPDATE_NOTIFICATION_PREFERENCES_MUTATION = `
  mutation UpdateMyNotificationPreferences($input: UpdateNotificationPreferencesInput!) {
    updateMyNotificationPreferences(input: $input) {
      emailEnabled
      smsEnabled
      pushEnabled
      quietHoursStart
      quietHoursEnd
      quietHoursTimezone
      alertNotifications
      taskNotifications
      systemNotifications
    }
  }
`;

// ============================================================================
// Mobile User Settings
// ============================================================================

export const GET_MOBILE_USERS_SETTINGS_QUERY = `
  query GetMobileUsersSettings {
    getMobileUsersSettings {
      id
      userId
      tenantId
      isMobileEnabled
      allowedFeatures
    }
  }
`;

export const UPDATE_MOBILE_USER_SETTINGS_MUTATION = `
  mutation UpdateMobileUserSettings($input: UpdateMobileUserSettingsInput!) {
    updateMobileUserSettings(input: $input) {
      id
      userId
      isMobileEnabled
      allowedFeatures
    }
  }
`;
