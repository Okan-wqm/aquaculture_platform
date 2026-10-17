/**
 * GraphQL documents the console's data hooks send through the gateway.
 *
 * WHY: each selects only what a console cell reads: alert-engine
 * activeAlertCounts, sensor-service edgeDeviceStats / edgeDevices, farm-service
 * activeSites, auth-service tenantUsers and tenantRoles. Field names match the
 * composed supergraph (shared-ui generated/graphql-types), which the hooks use
 * to type the responses.
 */

/**
 * Unresolved alarms per severity and acknowledgement, counted server-side: no
 * page, so an active alarm can neither be capped nor pushed out of the count.
 */
export const ACTIVE_ALERT_COUNTS_QUERY = `
  query ConsoleAlarmCounts {
    activeAlertCounts {
      severity
      acknowledged
      count
    }
  }
`;

/** The fleet in service: decommissioned and revoked devices are left out server-side. */
export const EDGE_DEVICE_STATS_QUERY = `
  query ConsoleDeviceStatus {
    edgeDeviceStats {
      inService
      onlineInService
    }
  }
`;

/** One page of edge devices; totalPages lets the reader walk the whole fleet. */
export const EDGE_DEVICES_QUERY = `
  query ConsoleEdgeDevices($isOnline: Boolean, $inService: Boolean, $page: Int, $limit: Int) {
    edgeDevices(isOnline: $isOnline, inService: $inService, page: $page, limit: $limit) {
      items {
        id
        deviceCode
        deviceName
        isOnline
        siteId
      }
      totalPages
    }
  }
`;

/** The viewer's active sites (site-scoped server-side; fails closed if incomplete). */
export const ACTIVE_SITES_QUERY = `
  query ConsoleActiveSites {
    activeSites {
      id
      name
    }
  }
`;

/** The tenant's users with what the palette matches (name, email) and hints (role); users:view. */
export const TENANT_USERS_QUERY = `
  query ConsolePalettePeople {
    tenantUsers {
      id
      firstName
      lastName
      email
      role
    }
  }
`;

export const TENANT_ROLES_QUERY = `
  query ConsoleViewAsRoles {
    tenantRoles {
      id
      name
      description
      color
      level
      isSystem
      permissions {
        resourcePermissions
      }
    }
  }
`;
