/**
 * Organization Chart Page — /hr/organization
 *
 * The departments of the reader's workspace as a nested chart, each with its
 * code, module, head count and manager. A module workspace draws that module's
 * departments, Company draws every one; the header says which. A department
 * whose parent lies outside the view is a root and says so, and nothing about
 * bad data is hidden (see buildOrgTree).
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { PageHeader, useI18n } from '@aquaculture/shared-ui';
import { ScopedDescription } from '../../components/common';
import { useOrganizationChart } from '../../hooks/useOrganizationChart';
import { OrgCycleWarning } from './OrgCycleWarning';
import { departmentCountLabel, unplacedLabel } from './orgLabels';
import { OrgTreeView } from './OrgTreeView';

const OrganizationChartPage: React.FC = () => {
  const { t } = useI18n();
  const { tree, unplacedHeadCount, isLoading, error } = useOrganizationChart();

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title={t('hr.orgChart.title')}
        description={
          <ScopedDescription text={tree ? departmentCountLabel(tree.departmentCount, t) : '-'} />
        }
      />

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-error-200 bg-error-50 p-4 text-sm text-error-700 dark:border-error-800 dark:bg-error-900/20 dark:text-error-400"
        >
          {t('hr.orgChart.loadError', { message: error.message })}
        </div>
      )}

      {isLoading && (
        <div role="status" aria-live="polite">
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
            {t('hr.orgChart.loading')}
          </p>
          <div className="space-y-3" aria-hidden="true">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="h-24 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-700"
              />
            ))}
          </div>
        </div>
      )}

      {tree && tree.cycles.length > 0 && <OrgCycleWarning cycles={tree.cycles} />}

      {tree && tree.roots.length === 0 && (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 text-center dark:border-gray-600 dark:bg-gray-800/50">
          <Building2
            className="mb-3 h-10 w-10 text-gray-500 dark:text-gray-400"
            aria-hidden="true"
          />
          <p className="text-gray-700 dark:text-gray-300">{t('hr.orgChart.empty')}</p>
          <Link
            to="/hr/departments"
            className="mt-3 text-sm text-primary-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600 dark:text-primary-400"
          >
            {t('hr.orgChart.manageDepartments')}
          </Link>
        </div>
      )}

      {tree && tree.roots.length > 0 && (
        <>
          <OrgTreeView roots={tree.roots} />
          {/* WHY: other pages count only `active` staff; a department's team includes people on leave. */}
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {t('hr.orgChart.headCountNote')}
          </p>
        </>
      )}

      {unplacedHeadCount > 0 && (
        <p className="text-sm text-gray-700 dark:text-gray-300">
          {unplacedLabel(unplacedHeadCount, t)}
        </p>
      )}
    </div>
  );
};

export default OrganizationChartPage;
