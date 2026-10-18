/**
 * Control & sensors (ctl) — devices, PLC, SCADA, maintenance and equipment
 * cost; the sensor module's workspace (design WSN `ctl`).
 *
 * Beyond the design tree: the process editor and its templates (a sensor page
 * the design files only under Production › Facility), the widget and classic
 * sensor dashboards, and a Configuration area for the sensor pages no nav
 * reached before — alarm rules, escalation, thresholds, industry setup,
 * calibration, tags and VFD programming.
 */
import { FARM_OPERATION_PAGES as OPS } from '../pages/farmOperations';
import { FARM_SETUP_PAGES as SETUP } from '../pages/farmSetup';
import { FINANCE_PAGES } from '../pages/finance';
import { SENSOR_PAGES as SNS } from '../pages/sensor';
import { SHELL_PAGES } from '../pages/shell';
import type { WorkspaceDef } from '../types';

import { financeArea, moduleOverviewArea, teamArea } from './shared';

export const CTL_WORKSPACE: WorkspaceDef = {
  id: 'ctl',
  labelKey: 'nav.workspace.ctl',
  descriptionKey: 'nav.workspace.ctl.description',
  accentToken: '--color-sd-ws-ctl',
  module: 'sensor',
  areas: [
    moduleOverviewArea('ctl-home', SHELL_PAGES.controlDashboard),
    {
      id: 'ctl-control',
      labelKey: 'nav.area.scadaDevices',
      icon: 'activity',
      groups: [
        {
          id: 'ctl-control-main',
          pages: [
            SNS.dashboard,
            SNS.devices,
            SNS.readings,
            SNS.waterChemistry,
            SNS.automation,
            SNS.commands,
            SNS.scada,
            SNS.processes,
            SNS.processTemplates,
            SNS.widgets,
            SNS.classicDashboard,
          ],
        },
        {
          id: 'ctl-plc',
          labelKey: 'nav.group.plc',
          pages: [SNS.plc, SNS.plcConnections, SNS.plcFeeding, SNS.plcAlarms],
        },
      ],
    },
    {
      id: 'ctl-config',
      labelKey: 'nav.configuration',
      icon: 'sliders-horizontal',
      groups: [
        {
          id: 'ctl-alarm-setup',
          labelKey: 'nav.group.alarmSetup',
          pages: [SNS.alertRules, SNS.escalationPolicies, SNS.thresholds],
        },
        {
          id: 'ctl-device-setup',
          labelKey: 'nav.group.deviceSetup',
          pages: [SNS.industrySetup, SNS.calibration, SNS.tags, SNS.vfdProgramming],
        },
      ],
    },
    {
      id: 'ctl-maintenance',
      labelKey: 'nav.maintenance',
      icon: 'cpu',
      groups: [
        { id: 'ctl-maintenance-main', pages: [OPS.maintenance, SETUP.equipment] },
        { id: 'ctl-site-work', labelKey: 'nav.group.siteWork', pages: [OPS.tasks, OPS.storage] },
      ],
    },
    teamArea('ctl-team'),
    financeArea('ctl-finance', [
      FINANCE_PAGES.overview,
      FINANCE_PAGES.expenses,
      FINANCE_PAGES.budget,
    ]),
  ],
};
