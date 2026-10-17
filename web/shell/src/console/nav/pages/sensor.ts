/**
 * Sensor-module pages (/sensor). Detail, editor and create routes are not menu
 * leaves; they light the list they open from (`matchPaths`).
 */
import type { ConsoleRole, NavPageDef } from '../types';

/**
 * Who sees the command log: the roles its route admits (sensor-module
 * CommandLogRoute, RequireRole MODULE_MANAGER), which are the roles the drive
 * trail and the deployment history are served to.
 */
const COMMAND_LOG_ROLES: readonly ConsoleRole[] = ['TENANT_ADMIN', 'MODULE_MANAGER'];

export const SENSOR_PAGES = {
  // The alarm list every workspace's Overview shares.
  alarms: {
    id: 'alarms',
    labelKey: 'nav.page.alarms',
    path: '/sensor/alerts',
    badge: 'alarmsUnack',
  },
  dashboard: {
    id: 'sensor-dashboard',
    labelKey: 'nav.page.sensorDashboard',
    path: '/sensor',
    matchPaths: ['/sensor/scada'],
  },
  devices: {
    id: 'sensor-devices',
    labelKey: 'nav.devices',
    path: '/sensor/devices',
    matchPaths: [
      '/sensor/devices/:deviceId',
      '/sensor/devices/edge/:deviceId',
      '/sensor/devices/edge/:deviceId/config',
      '/sensor/devices/vfd/:deviceId',
    ],
  },
  readings: { id: 'sensor-readings', labelKey: 'nav.readings', path: '/sensor/readings' },
  waterChemistry: {
    id: 'sensor-water-chemistry',
    labelKey: 'nav.waterChemistry',
    path: '/sensor/water-chemistry',
    matchPaths: ['/sensor/water-chemistry/:scopeKind/:scopeId'],
  },
  automation: {
    id: 'sensor-automation',
    labelKey: 'nav.automation',
    path: '/sensor/automation',
    matchPaths: ['/sensor/automation/new', '/sensor/automation/:programId'],
  },
  // Built in this program; the unified log and locks render as a labelled
  // preview until sensor-service records them (SENSOR-MEDIUM-185).
  commands: {
    id: 'sensor-commands',
    labelKey: 'nav.page.commandLog',
    path: '/sensor/commands',
    requiredRoles: COMMAND_LOG_ROLES,
  },
  scada: {
    id: 'sensor-scada',
    labelKey: 'nav.page.scadaProcess',
    path: '/sensor/scada-packages',
    matchPaths: [
      '/sensor/scada-builder/new',
      '/sensor/scada-builder/:packageId',
      '/sensor/scada/operator/:packageId',
    ],
  },
  processes: {
    id: 'sensor-processes',
    labelKey: 'nav.page.processDiagram',
    path: '/sensor/processes',
    matchPaths: [
      '/sensor/process/new',
      '/sensor/process/:processId',
      '/sensor/unified-editor/new',
      '/sensor/unified-editor/:processId',
    ],
  },
  processTemplates: {
    id: 'sensor-process-templates',
    labelKey: 'nav.page.processTemplates',
    path: '/sensor/processes/templates',
  },
  widgets: { id: 'sensor-widgets', labelKey: 'nav.page.widgetDashboard', path: '/sensor/widgets' },
  classicDashboard: {
    id: 'sensor-classic-dashboard',
    labelKey: 'nav.page.classicSensorDashboard',
    path: '/sensor/dashboard',
  },
  plc: { id: 'sensor-plc', labelKey: 'nav.plcControl', path: '/sensor/plc' },
  plcConnections: {
    id: 'sensor-plc-connections',
    labelKey: 'nav.plcConnections',
    path: '/sensor/plc/connections',
  },
  plcFeeding: {
    id: 'sensor-plc-feeding',
    labelKey: 'nav.feedingParams',
    path: '/sensor/plc/feeding',
  },
  plcAlarms: { id: 'sensor-plc-alarms', labelKey: 'nav.plcAlarms', path: '/sensor/plc/alarms' },
  alertRules: {
    id: 'sensor-alert-rules',
    labelKey: 'nav.page.alertRules',
    path: '/sensor/alert-rules',
  },
  escalationPolicies: {
    id: 'sensor-escalation-policies',
    labelKey: 'nav.page.escalationPolicies',
    path: '/sensor/escalation-policies',
  },
  thresholds: {
    id: 'sensor-thresholds',
    labelKey: 'nav.page.thresholds',
    path: '/sensor/thresholds',
  },
  industrySetup: {
    id: 'sensor-industry-setup',
    labelKey: 'nav.page.industrySetup',
    path: '/sensor/setup',
  },
  calibration: {
    id: 'sensor-calibration',
    labelKey: 'nav.page.calibration',
    path: '/sensor/calibration',
  },
  tags: { id: 'sensor-tags', labelKey: 'nav.page.tagRegistry', path: '/sensor/tags' },
  vfdProgramming: {
    id: 'sensor-vfd-programming',
    labelKey: 'nav.page.vfdProgramming',
    path: '/sensor/vfd-programming',
    matchPaths: ['/sensor/vfd-programming/:deviceId'],
  },
} satisfies Record<string, NavPageDef>;
