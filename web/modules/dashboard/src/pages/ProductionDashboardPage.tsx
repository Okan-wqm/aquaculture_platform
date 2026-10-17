/**
 * Production's dashboard (/dashboard): the fish sites of the farm module and
 * the farm module's alarms.
 */
import { useI18n } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';

import { ProductionSiteTable } from '../panels/ProductionSiteTable';

import { ModuleDashboard } from './ModuleDashboard';

export default function ProductionDashboardPage(): ReactElement {
  const { t } = useI18n();
  return (
    <ModuleDashboard
      title={t('dashboard.production.title')}
      description={t('dashboard.production.description')}
      module="FARM"
      siteTable={(now) => <ProductionSiteTable now={now} />}
    />
  );
}
