/**
 * Control & sensors dashboard: one site's row of the Site status table.
 *
 * WHY these sources: the gateways are the site's in-service edge devices
 * (online count, newest report), the sensors the ones registered at the site,
 * the PLCs the site's PLC connections and their active PLC alarms (attributed
 * to the site through their connection). Alarm counts are the sensor module's
 * alarms on the site (alert-engine, module SENSOR). EdgeDevice.activeAlarmCount
 * is not read: it counts the tenant's alarms, not the device's.
 *
 * WHAT: gatewaySummary, plcSummary and the row type.
 */
import type { AlarmPriorityTally } from '@aquaculture/shared-ui';

import type { Cell } from './cell';
import type { GatewayRecord } from './production';

export interface GatewaySummary {
  readonly online: number;
  readonly total: number;
  readonly lastSeenAt: Date | null;
}

export interface PlcSummary {
  readonly online: number;
  readonly total: number;
  readonly activeAlarms: number;
}

export interface ControlSiteRow {
  readonly siteId: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly alarms: Cell<AlarmPriorityTally>;
  readonly gateways: Cell<GatewaySummary>;
  readonly sensors: Cell<number>;
  readonly plcs: Cell<PlcSummary>;
}

export function gatewaySummary(gateways: readonly GatewayRecord[]): GatewaySummary {
  let lastSeen: number | null = null;
  for (const gateway of gateways) {
    if (gateway.lastSeenAt === null) continue;
    const time = Date.parse(gateway.lastSeenAt);
    if (Number.isFinite(time) && (lastSeen === null || time > lastSeen)) lastSeen = time;
  }
  return {
    online: gateways.filter((gateway) => gateway.isOnline).length,
    total: gateways.length,
    lastSeenAt: lastSeen === null ? null : new Date(lastSeen),
  };
}

export function plcSummary(
  connections: readonly { readonly id: string; readonly status: string }[],
  alarms: readonly { readonly plcConnectionId: string }[],
): PlcSummary {
  const ids = new Set(connections.map((connection) => connection.id));
  return {
    online: connections.filter((connection) => connection.status === 'ONLINE').length,
    total: connections.length,
    activeAlarms: alarms.filter((alarm) => ids.has(alarm.plcConnectionId)).length,
  };
}
