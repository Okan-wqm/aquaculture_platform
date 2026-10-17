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
 * systems, parameter configs, the units' resolved readings, day plans and
 * unit temperatures admit every module role, scoped to the caller's sites
 * where the farm scopes them; edge devices, sensors, PLCs and alarms admit any
 * tenant user; tenant billing, tenant stats, announcements and audit logs are
 * the tenant admin's; tenant users need users:view. The hooks fire each
 * document only for a viewer its guard admits.
 *
 * DashboardOperationResults names what each document answers, in the
 * supergraph's generated types: the hooks read responses as these, and the
 * specs' fake gateway must answer with them.
 */
import type { AuditEntry } from '../model/activity';
import type { AlarmRecord, SiteAlarmCountRow } from '../model/alarms';
import type { PlcAlarmRecord, PlcConnectionRecord } from '../model/control';
import type { AnnouncementRecord, UserRecord } from '../model/inbox';
import type {
  DayPlanRecord,
  GatewayRecord,
  OxygenParameterRecord,
  SystemRecord,
  UnitReadingRecord,
  UnitTemperatureRecord,
} from '../model/production';
import type { DashboardSite } from '../model/site';
import type {
  AlertHistory,
  TenantPlanLimitsDto,
  TenantStats,
} from '@platform/shared-ui/generated/graphql-types';

export interface DashboardOperationResults {
  readonly DashboardActiveSites: { readonly activeSites: readonly DashboardSite[] };
  readonly DashboardSiteAlarmCounts: { readonly activeAlertCounts: readonly SiteAlarmCountRow[] };
  readonly DashboardModuleAlarms: {
    readonly open: readonly AlarmRecord[];
    readonly returned: readonly AlarmRecord[];
  };
  readonly DashboardAcknowledgeAlert: {
    readonly acknowledgeAlert: Pick<AlertHistory, 'id' | 'acknowledged'>;
  };
  readonly DashboardSiteGateways: {
    readonly edgeDevices: { readonly items: readonly GatewayRecord[]; readonly total: number };
  };
  readonly DashboardParameterLimits: {
    readonly parameterConfigs: readonly OxygenParameterRecord[];
  };
  readonly DashboardUnitOxygen: {
    readonly resolvedUnitParameterValues: readonly UnitReadingRecord[];
  };
  readonly DashboardSiteDayPlans: { readonly feedingDayPlans: readonly DayPlanRecord[] };
  readonly DashboardUnitTemperatures: {
    readonly effectiveUnitTemperatures: readonly UnitTemperatureRecord[];
  };
  readonly DashboardSiteSystems: { readonly systems: { readonly items: readonly SystemRecord[] } };
  readonly DashboardSiteSensorTotal: { readonly sensors: { readonly total: number } };
  readonly DashboardSitePlcs: { readonly plcConnectionsBySite: readonly PlcConnectionRecord[] };
  readonly DashboardActivePlcAlarms: { readonly activePlcAlarms: readonly PlcAlarmRecord[] };
  readonly DashboardSeats: {
    readonly tenantBilling: {
      readonly planLimits?: Pick<TenantPlanLimitsDto, 'maxUsers' | 'currentUsers'> | null;
    };
    readonly tenantStats: Pick<TenantStats, 'pendingUsers'>;
  };
  readonly DashboardUsers: { readonly tenantUsers: readonly UserRecord[] };
  readonly DashboardMaintenance: { readonly myAnnouncements: readonly AnnouncementRecord[] };
  readonly DashboardRecentAudit: {
    readonly tenantAuditLogs: { readonly data: readonly AuditEntry[] };
  };
}

export type DashboardOperation = keyof DashboardOperationResults;

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
 * nobody has acknowledged yet (returned to normal, still awaiting a look) —
 * each page the most severe first, so its limit cuts the mildest alarms and
 * never an older P1 behind newer, milder ones.
 */
export const MODULE_ALARMS_QUERY = `
  query DashboardModuleAlarms($module: AlertModule!, $severities: [AlertSeverity!]!) {
    open: alertHistory(
      module: $module
      resolved: false
      severities: $severities
      orderBy: MOST_SEVERE_FIRST
      limit: 50
    ) {
      ${ALARM_FIELDS}
    }
    returned: alertHistory(
      module: $module
      resolved: true
      acknowledged: false
      severities: $severities
      orderBy: MOST_SEVERE_FIRST
      limit: 50
    ) {
      ${ALARM_FIELDS}
    }
  }
`;

/** Acknowledge one alarm (alert-engine acknowledgeAlert, open to every module role). */
export const ACKNOWLEDGE_ALERT_MUTATION = `
  mutation DashboardAcknowledgeAlert($input: AcknowledgeAlertInput!) {
    acknowledgeAlert(input: $input) {
      id
      acknowledged
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

/** The tenant's active parameters: dissolved oxygen's id, unit and limits among them. */
export const PARAMETER_LIMITS_QUERY = `
  query DashboardParameterLimits {
    parameterConfigs(filter: { isActive: true }) {
      id
      code
      unit
      warningMin
      criticalMin
    }
  }
`;

/**
 * One parameter (dissolved oxygen) at each of a site's fed units, read by
 * farm's one reading resolver: a live channel first, else a person's latest
 * sample, in the parameter's unit, none older than the window. One entry per
 * asked unit; a unit farm no longer has comes back with no reading.
 */
export const UNIT_OXYGEN_QUERY = `
  query DashboardUnitOxygen($input: ResolvedUnitParameterValuesInput!) {
    resolvedUnitParameterValues(input: $input) {
      unitId
      reading {
        value
        unit
        sourceKind
        observedAt
        unresolved
      }
    }
  }
`;

/** The site's feeding day plans of its local day: planned and fed kg per unit, and the meal schedule. */
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
        plannedKg
        scheduledAt
        status
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

/** The tenant's users: names for the activity, roles and two-factor state for the inbox (users:view). */
export const TENANT_USERS_QUERY = `
  query DashboardUsers {
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
