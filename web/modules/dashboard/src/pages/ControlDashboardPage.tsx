/**
 * Control & sensors' dashboard (/dashboard/control): each site's gateways,
 * sensors and PLCs, and the sensor module's alarms.
 */
import { useI18n } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';

import { ControlSiteTable } from '../panels/ControlSiteTable';

import { ModuleDashboard } from './ModuleDashboard';

export default function ControlDashboardPage(): ReactElement {
  const { t } = useI18n();
  return (
    <ModuleDashboard
      title={t('dashboard.control.title')}
      description={t('dashboard.control.description')}
      module="SENSOR"
      siteTable={(now) => <ControlSiteTable now={now} />}
    />
  );
}
