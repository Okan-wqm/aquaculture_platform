/**
 * GraphQL documents the module dashboards send through the gateway.
 *
 * WHY here and not imported: the dashboard remote cannot import the farm,
 * sensor or tenant-admin remotes' code, so it carries its own documents, each
 * selecting only what a dashboard cell reads. Field names match the composed
 * supergraph (shared-ui generated/graphql-types), which the hooks use to type
 * the responses.
 *
 * WHO may send them (resolver guards, checked for this change): sites,
 * systems, water quality, parameter configs, day plans and unit temperatures
 * admit every module role, scoped to the caller's sites where the farm scopes
 * them; edge devices, sensors, PLCs and alarms admit any tenant user; tenant
 * billing, tenant stats, announcements and audit logs are the tenant admin's;
 * tenant users need users:view. The hooks fire each document only for a viewer
 * its guard admits.
 */

// ── Shared ──────────────────────────────────────────────────────────────

/** The viewer's active sites (site-scoped server-side for a module user). */
export const ACTIVE_SITES_QUERY = `
  query DashboardActiveSites {
    activeSites {
      id
      code
      name
      type
      timezone
    }
  }
`;

/** One module's unresolved alarms per site, severity and acknowledgement. */
export const SITE_ALARM_COUNTS_QUERY = `
  query DashboardSiteAlarmCounts($module: AlertModule!) {
    activeAlertCounts(module: $module, groupBy: [SITE]) {
      severity
      acknowledged
      siteId
      count
    }
  }
`;

const ALARM_FIELDS = `
  id
  ruleName
  message
  severity
  acknowledged
  resolved
  triggeredAt
  siteId
`;

/**
 * One module's alarms the panel can show: the open ones, and the cleared ones
 * nobody has acknowledged yet (returned to normal, still awaiting a look).
 */
export const MODULE_ALARMS_QUERY = `
  query DashboardModuleAlarms($module: AlertModule!, $severities: [AlertSeverity!]!) {
    open: alertHistory(module: $module, resolved: false, severities: $severities, limit: 50) {
      ${ALARM_FIELDS}
    }
    returned: alertHistory(
      module: $module
      resolved: true
      acknowledged: false
      severities: $severities
      limit: 50
    ) {
      ${ALARM_FIELDS}
    }
  }
`;

// ── Production site rows ───────────────────────────────────────────────

/** A site's in-service gateways: whether each is online and when it last reported. */
export const SITE_GATEWAYS_QUERY = `
  query DashboardSiteGateways($siteId: ID!) {
    edgeDevices(siteId: $siteId, inService: true, limit: 100) {
      items {
        id
        isOnline
        lastSeenAt
      }
      total
    }
  }
`;

/** The site's water-quality measurements of the last day, newest first. */
export const SITE_MEASUREMENTS_QUERY = `
  query DashboardSiteMeasurements($siteId: ID!, $fromDate: DateTime!) {
    waterQualityMeasurements(filter: { siteId: $siteId, fromDate: $fromDate, limit: 100 }) {
      items {
        id
        tankId
        equipmentId
        dissolvedOxygen
        measuredAt
      }
    }
  }
`;

/** The tenant's active parameter limits (dissolved oxygen's among them). */
export const PARAMETER_LIMITS_QUERY = `
  query DashboardParameterLimits {
    parameterConfigs(filter: { isActive: true }) {
      code
      warningMin
      criticalMin
    }
  }
`;

/** The site's feeding day plans of its local day: planned and fed kg per unit. */
export const SITE_DAY_PLANS_QUERY = `
  query DashboardSiteDayPlans($planDate: String!, $siteId: ID!) {
    feedingDayPlans(planDate: $planDate, siteId: $siteId) {
      id
      unitId
      unitCode
      status
      plannedTotalKg
      unplannedActualKg
      meals {
        actualKg
      }
    }
  }
`;

/** The water temperature each unit's feeding runs on now. */
export const UNIT_TEMPERATURES_QUERY = `
  query DashboardUnitTemperatures($unitIds: [ID!]!) {
    effectiveUnitTemperatures(unitIds: $unitIds) {
      unitId
      celsius
      measuredAt
    }
  }
`;

/** The site's systems, for the tank count entered on them. */
export const SITE_SYSTEMS_QUERY = `
  query DashboardSiteSystems($siteId: ID!) {
    systems(filter: { siteId: $siteId }, pagination: { limit: 100 }) {
      items {
        id
        tankCount
      }
    }
  }
`;

// ── Control site rows ──────────────────────────────────────────────────

/** How many sensors are registered at the site (one item fetched: the total is the answer). */
export const SITE_SENSOR_TOTAL_QUERY = `
  query DashboardSiteSensorTotal($siteId: ID!) {
    sensors(filter: { siteId: $siteId }, pagination: { limit: 1 }) {
      total
    }
  }
`;

/** The site's PLC connections and their link state. */
export const SITE_PLCS_QUERY = `
  query DashboardSitePlcs($siteId: ID!) {
    plcConnectionsBySite(siteId: $siteId) {
      id
      status
    }
  }
`;

/** Every active PLC alarm of the tenant, by connection. */
export const ACTIVE_PLC_ALARMS_QUERY = `
  query DashboardActivePlcAlarms {
    activePlcAlarms {
      id
      plcConnectionId
    }
  }
`;

// ── Inbox and activity ─────────────────────────────────────────────────

/** Seats in use and the plan's seat limit (tenant admin). */
export const SEATS_QUERY = `
  query DashboardSeats {
    tenantBilling {
      planLimits {
        maxUsers
        currentUsers
      }
    }
    tenantStats {
      pendingUsers
    }
  }
`;

/** The tenant's users with their role and two-factor state (users:view). */
export const USERS_MFA_QUERY = `
  query DashboardUsersMfa {
    tenantUsers {
      id
      firstName
      lastName
      email
      role
      isActive
      mfaEnabled
    }
  }
`;

/** Maintenance announcements addressed to the viewer (tenant admin). */
export const MAINTENANCE_ANNOUNCEMENTS_QUERY = `
  query DashboardMaintenance {
    myAnnouncements(type: MAINTENANCE) {
      id
      title
      isActive
      publishAt
      expiresAt
      createdAt
    }
  }
`;

/** The latest audit entries (tenant admin). */
export const RECENT_AUDIT_QUERY = `
  query DashboardRecentAudit($limit: Int!) {
    tenantAuditLogs(limit: $limit) {
      data {
        id
        action
        entityType
        performedBy
        performedByEmail
        createdAt
      }
    }
  }
`;
