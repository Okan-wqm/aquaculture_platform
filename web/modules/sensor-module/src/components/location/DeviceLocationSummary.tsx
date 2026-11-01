/**
 * A device's place shown by name: site, department, system, and the tank or
 * equipment it stands in. Each level is read by its id (never looked up in a
 * paged list, which would miss rows beyond its page), so a stored place reads
 * by name; a level farm no longer has reads "not found or inactive", a read
 * that failed reads as such, never as a raw id or an endless "loading".
 */
import { GraphQLClientError, useI18n } from '@aquaculture/shared-ui';
import type { UseQueryResult } from '@tanstack/react-query';
import React from 'react';

import { useEquipment } from '../../hooks/useEquipment';
import { useDepartmentName, useSiteName, useSystemName } from '../../hooks/useLocationHierarchy';

import type { DeviceLocation } from './DeviceLocationFields';

export function DeviceLocationSummary({
  location,
}: {
  location: DeviceLocation;
}): React.ReactElement {
  const { t } = useI18n();
  const site = useSiteName(location.siteId);
  const department = useDepartmentName(location.departmentId);
  const system = useSystemName(location.systemId);
  // farm's equipment(id) answers tanks and other water equipment alike.
  const unit = useEquipment(location.unitId ?? '');

  const nameOf = (
    id: string | undefined,
    read: UseQueryResult<{ name: string } | null | undefined>,
  ): string => {
    if (!id) return t('sensor.location.notSet');
    if (read.isError) {
      return read.error instanceof GraphQLClientError && read.error.code === 'NOT_FOUND'
        ? t('sensor.location.unknown')
        : t('sensor.location.unavailable');
    }
    if (read.isPending) return t('sensor.location.loading');
    return read.data?.name ?? t('sensor.location.unknown');
  };

  const levels: Array<[label: string, name: string]> = [
    [t('sensor.location.site'), nameOf(location.siteId, site)],
    [t('sensor.location.department'), nameOf(location.departmentId, department)],
    [t('sensor.location.system'), nameOf(location.systemId, system)],
    [t('sensor.location.unit'), nameOf(location.unitId, unit)],
  ];

  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2" data-testid="device-location">
      {levels.map(([label, name]) => (
        <div key={label}>
          <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
          <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">{name}</dd>
        </div>
      ))}
    </dl>
  );
}
