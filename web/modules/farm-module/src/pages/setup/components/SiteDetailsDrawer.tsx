/**
 * SiteDetailsDrawer — the read-only view of one site (SitesTab "View Details").
 *
 * WHY (FE-MEDIUM-310): farm-module has no site detail route (`/sites/:siteId`
 * redirects back to the list), so "View Details" first navigated nowhere and
 * then (#1670) opened the EDIT form: a write surface, shown even to users who
 * cannot update sites. Viewing is a read. This drawer renders the record the
 * list query already holds, with no inputs and no save path; editing stays
 * behind SitesTab's permission-gated edit button.
 */
import React from 'react';
import { Drawer, useI18n, type MessageKey } from '@aquaculture/shared-ui';

import type { Site } from '../../../hooks/useSites';

export interface SiteDetailsDrawerProps {
  /** The site to show; `null` keeps the drawer closed. */
  site: Site | null;
  onClose: () => void;
}

type DetailRow = readonly [label: MessageKey, value: string];

function joinPresent(parts: ReadonlyArray<string | null | undefined>, separator = ', '): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(separator);
}

function detailRows(site: Site, inheritedTimezone: string): DetailRow[] {
  const address = site.address
    ? joinPresent([
        site.address.street,
        joinPresent([site.address.postalCode, site.address.city], ' '),
        site.address.state,
        site.address.country,
      ])
    : '';
  const location = site.location
    ? `${site.location.latitude.toFixed(5)}, ${site.location.longitude.toFixed(5)}`
    : '';

  return [
    ['sites.details.code', site.code],
    ['sites.details.type', site.type],
    ['sites.details.status', site.status],
    [
      'sites.details.lokalitetsnummer',
      site.lokalitetsnummer != null ? String(site.lokalitetsnummer) : '',
    ],
    ['sites.details.timezone', site.timezone ?? inheritedTimezone],
    ['sites.details.region', joinPresent([site.region, site.country])],
    ['sites.details.address', address],
    ['sites.details.location', location],
    [
      'sites.details.totalArea',
      site.totalArea != null ? `${site.totalArea.toLocaleString()} m²` : '',
    ],
    ['sites.details.monitoringRadius', `${site.monitoringRadiusM.toLocaleString()} m`],
    ['sites.details.siteManager', site.siteManager ?? ''],
    ['sites.details.contactEmail', site.contactEmail ?? ''],
    ['sites.details.contactPhone', site.contactPhone ?? ''],
    ['sites.details.description', site.description ?? ''],
    ['sites.details.createdAt', new Date(site.createdAt).toLocaleDateString()],
  ];
}

export const SiteDetailsDrawer: React.FC<SiteDetailsDrawerProps> = ({ site, onClose }) => {
  const { t } = useI18n();

  return (
    <Drawer
      isOpen={site !== null}
      onClose={onClose}
      title={site === null ? undefined : site.name}
      description={t('sites.details.subtitle')}
      closeLabel={t('common.close')}
    >
      {site !== null && (
        <dl className="divide-y divide-gray-200 dark:divide-gray-700">
          {detailRows(site, t('sites.details.timezoneInherited')).map(([label, value]) => (
            <div key={label} className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-3 sm:gap-4">
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">{t(label)}</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100 sm:col-span-2 break-words">
                {value === '' ? t('sites.details.notSet') : value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Drawer>
  );
};

export default SiteDetailsDrawer;
