/**
 * Greenhouse's dashboard (/dashboard/greenhouse): the zone table as a
 * labelled preview (PRODUCT-MEDIUM-001) and the hydroponics module's alarms.
 */
import { useI18n } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';

import { GreenhouseZoneTable } from '../panels/GreenhouseZoneTable';

import { ModuleDashboard } from './ModuleDashboard';

export default function GreenhouseDashboardPage(): ReactElement {
  const { t } = useI18n();
  return (
    <ModuleDashboard
      title={t('dashboard.greenhouse.title')}
      description={t('dashboard.greenhouse.description')}
      module="HYDROPONICS"
      siteTable={() => <GreenhouseZoneTable />}
    />
  );
}
