/**
 * "Sites without a responsible person": active sites with no site contact, or
 * with contacts but none primary (see unassignedSites). Contacts are edited on
 * the farm setup's Sites tab, which the header links to.
 */
import React, { useId } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, useI18n } from '@aquaculture/shared-ui';

import type { UnassignedSite } from './unassignedSites';
import { PanelBody } from './PanelBody';

/** farm-module's setup tab where SiteFormModal edits a site's contacts. */
const SITE_CONTACTS_PATH = '/sites/setup/sites';

export interface UnassignedSitesPanelProps {
  sites: readonly UnassignedSite[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

export function UnassignedSitesPanel({
  sites,
  isLoading,
  isError,
  onRetry,
}: UnassignedSitesPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const headingId = useId();

  return (
    <section aria-labelledby={headingId}>
      <Card
        padding="none"
        title={<span id={headingId}>{t('hr.today.unassigned.title')}</span>}
        headerAction={
          <Link
            to={SITE_CONTACTS_PATH}
            className="text-sm font-medium text-primary-700 hover:underline dark:text-primary-300"
          >
            {t('hr.today.unassigned.manage')}
          </Link>
        }
      >
        <PanelBody
          isLoading={isLoading}
          isError={isError}
          onRetry={onRetry}
          isEmpty={sites.length === 0}
          emptyTitle={t('hr.today.unassigned.empty')}
        >
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {sites.map((site) => (
              <li key={site.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3">
                <span className="min-w-0 flex-1 font-semibold text-gray-900 dark:text-gray-100">
                  {site.name}
                </span>
                <Badge size="sm" variant={site.gap === 'noContact' ? 'warning' : 'outline'}>
                  {site.gap === 'noContact'
                    ? t('hr.today.unassigned.noContact')
                    : t('hr.today.unassigned.noPrimary', { count: site.contactCount })}
                </Badge>
              </li>
            ))}
          </ul>
        </PanelBody>
      </Card>
    </section>
  );
}
