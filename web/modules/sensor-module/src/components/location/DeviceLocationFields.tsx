/**
 * Where a device stands, picked down the farm topology: a site, a department
 * of it, then optionally a system of that department (or a site-wide one)
 * and a unit (a tank, pond or cage, or other water equipment). The one picker
 * the registration wizard and the device page's move dialog share. Farm
 * checks the path when it is saved and decides whether the unit is a tank
 * (SENSOR-MEDIUM-161), so the picker sends the unit as it is, never
 * classified here.
 */
import { Select, useI18n } from '@aquaculture/shared-ui';
import React, { useMemo } from 'react';

import { useEquipmentList } from '../../hooks/useEquipment';
import {
  useDepartmentsBySite,
  useSiteList,
  useSystemsBySite,
} from '../../hooks/useLocationHierarchy';

/** A place in the farm topology, each level below the site optional. */
export interface DeviceLocation {
  siteId?: string;
  departmentId?: string;
  systemId?: string;
  unitId?: string;
}

interface Named {
  id: string;
  name: string;
  code: string;
}

type Option = { value: string; label: string };

const option = (row: Named): Option => ({ value: row.id, label: `${row.name} (${row.code})` });

/** Farm's lists carry at most this many units; the picker asks for all of them. */
const UNIT_PAGE = { limit: 100 };

export interface DeviceLocationFieldsProps {
  value: DeviceLocation;
  onChange: (next: DeviceLocation) => void;
  disabled?: boolean;
}

export function DeviceLocationFields({
  value,
  onChange,
  disabled = false,
}: DeviceLocationFieldsProps): React.ReactElement {
  const { t } = useI18n();
  const sites = useSiteList({ isActive: true });
  const departments = useDepartmentsBySite(value.siteId ?? '');
  const systems = useSystemsBySite(value.siteId ?? '');
  // Farm's list narrows the units to the picked department and system (tanks
  // and system-linked equipment alike); nothing is read before a department.
  const units = useEquipmentList(
    { departmentId: value.departmentId, systemId: value.systemId, isActive: true },
    UNIT_PAGE,
    { enabled: Boolean(value.departmentId) },
  );

  const siteOptions = useMemo(() => (sites.data?.items ?? []).map(option), [sites.data]);
  // Only the levels farm would accept: live departments, and systems of the
  // chosen department or of the whole site.
  const departmentOptions = useMemo(
    () => (departments.data ?? []).filter((row) => row.isActive).map(option),
    [departments.data],
  );
  const systemOptions = useMemo(
    () =>
      (systems.data ?? [])
        .filter((row) => !row.departmentId || row.departmentId === value.departmentId)
        .map(option),
    [systems.data, value.departmentId],
  );
  const unitOptions = useMemo(() => (units.data?.items ?? []).map(option), [units.data]);

  // A stored level the list does not offer (inactive now, or beyond a page)
  // is shown as what it is: a select with no matching option would show
  // another one while the hidden id is still what gets saved.
  const withCurrent = (current: string | undefined, loaded: boolean, rows: Option[]): Option[] =>
    current && loaded && !rows.some((row) => row.value === current)
      ? [{ value: current, label: t('sensor.location.currentNotListed') }, ...rows]
      : rows;
  // The system and the unit are optional: their lists open with an explicit
  // "none" a user can go back to (a placeholder option cannot be re-chosen).
  const optional = (ready: boolean, none: string, rows: Option[]): Option[] =>
    ready ? [{ value: '', label: none }, ...rows] : [];
  const listError = (failed: boolean): string | undefined =>
    failed ? t('sensor.location.listFailed') : undefined;
  const dependentPlaceholder = (
    loading: boolean,
    ready: boolean,
    notReady: string,
  ): string | undefined => (!ready ? notReady : loading ? t('sensor.location.loading') : undefined);

  // Choosing a level clears every level below it: they belonged to the old choice.
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Select
        fullWidth
        required
        label={t('sensor.location.site')}
        value={value.siteId ?? ''}
        disabled={disabled || sites.isLoading}
        placeholder={
          sites.isLoading ? t('sensor.location.loading') : t('sensor.location.chooseSite')
        }
        error={listError(sites.isError)}
        options={withCurrent(value.siteId, sites.isSuccess, siteOptions)}
        onChange={(event) => onChange({ siteId: event.target.value || undefined })}
      />
      <Select
        fullWidth
        required
        label={t('sensor.location.department')}
        value={value.departmentId ?? ''}
        disabled={disabled || !value.siteId || departments.isLoading}
        placeholder={
          dependentPlaceholder(
            departments.isLoading,
            Boolean(value.siteId),
            t('sensor.location.siteFirst'),
          ) ?? t('sensor.location.chooseDepartment')
        }
        error={listError(departments.isError)}
        options={withCurrent(value.departmentId, departments.isSuccess, departmentOptions)}
        onChange={(event) =>
          onChange({ siteId: value.siteId, departmentId: event.target.value || undefined })
        }
      />
      <Select
        fullWidth
        label={t('sensor.location.system')}
        value={value.systemId ?? ''}
        disabled={disabled || !value.departmentId || systems.isLoading}
        placeholder={dependentPlaceholder(
          systems.isLoading,
          Boolean(value.departmentId),
          t('sensor.location.departmentFirst'),
        )}
        error={listError(systems.isError)}
        options={optional(
          Boolean(value.departmentId),
          t('sensor.location.noSystem'),
          withCurrent(value.systemId, systems.isSuccess, systemOptions),
        )}
        onChange={(event) =>
          onChange({
            siteId: value.siteId,
            departmentId: value.departmentId,
            systemId: event.target.value || undefined,
          })
        }
      />
      <Select
        fullWidth
        label={t('sensor.location.unit')}
        value={value.unitId ?? ''}
        disabled={disabled || !value.departmentId || units.isLoading}
        placeholder={dependentPlaceholder(
          units.isLoading,
          Boolean(value.departmentId),
          t('sensor.location.departmentFirst'),
        )}
        error={listError(units.isError)}
        options={optional(
          Boolean(value.departmentId),
          t('sensor.location.noUnit'),
          withCurrent(value.unitId, units.isSuccess, unitOptions),
        )}
        onChange={(event) => onChange({ ...value, unitId: event.target.value || undefined })}
      />
    </div>
  );
}
