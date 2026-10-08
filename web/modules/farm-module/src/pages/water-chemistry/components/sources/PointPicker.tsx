/**
 * Picks a measurement point: a site (also the filter of the lists below), then
 * a system, a tank or non-tank water equipment of it — or the site itself.
 * A tank is a unit flagged as a tank (the backend's own rule, which refuses a
 * tank named as equipment); every other active unit is water equipment.
 */
import { Select, useI18n, type PointKind, type PointRef } from '@aquaculture/shared-ui';
import React, { useMemo, useState } from 'react';

import { useEquipmentList } from '../../../../hooks/useEquipment';
import { useSiteList } from '../../../../hooks/useSites';
import { useSystemList } from '../../../../hooks/useSystems';
import { useTanksList } from '../../../../hooks/useTanks';

export interface PointPickerProps {
  value: PointRef | null;
  onChange: (point: PointRef | null) => void;
  /** The kinds offered (the calculator offers only systems and tanks). */
  kinds?: readonly PointKind[];
  /** The site the lists are narrowed to, reported so a caller can narrow its own lists. */
  onSiteChange?: (siteId: string | null) => void;
}

const ALL_KINDS: readonly PointKind[] = ['system', 'tank', 'equipment', 'site'];

interface Option {
  value: string;
  label: string;
}

export const PointPicker: React.FC<PointPickerProps> = ({
  value,
  onChange,
  kinds = ALL_KINDS,
  onSiteChange,
}) => {
  const { t } = useI18n();
  const [siteId, setSiteId] = useState<string | null>(value?.kind === 'site' ? value.id : null);
  const [kind, setKind] = useState<PointKind>(value?.kind ?? kinds[0] ?? 'system');
  const siteFilter = siteId ?? undefined;

  const sites = useSiteList({ isActive: true });
  const systems = useSystemList({ siteId: siteFilter, isActive: true });
  const tanks = useTanksList({ siteId: siteFilter, isActive: true, isTank: true });
  const equipment = useEquipmentList({ siteId: siteFilter, isActive: true });

  const options = useMemo((): Option[] => {
    if (kind === 'system') {
      return (systems.data?.items ?? []).map((system) => ({
        value: system.id,
        label: `${system.name} (${system.code})`,
      }));
    }
    const tankItems = tanks.data?.items ?? [];
    if (kind === 'tank') {
      return tankItems.map((tank) => ({ value: tank.id, label: `${tank.name} (${tank.code})` }));
    }
    if (kind === 'equipment') {
      const tankIds = new Set(tankItems.map((tank) => tank.id));
      return (equipment.data?.items ?? [])
        .filter((item) => !tankIds.has(item.id))
        .map((item) => ({ value: item.id, label: `${item.name} (${item.code})` }));
    }
    return [];
  }, [kind, systems.data, tanks.data, equipment.data]);

  const changeSite = (next: string): void => {
    const nextSite = next === '' ? null : next;
    setSiteId(nextSite);
    onSiteChange?.(nextSite);
    onChange(kind === 'site' && nextSite !== null ? { kind: 'site', id: nextSite } : null);
  };

  const changeKind = (next: PointKind): void => {
    setKind(next);
    onChange(next === 'site' && siteId !== null ? { kind: 'site', id: siteId } : null);
  };

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Select
        label={t('wqSource.ui.site')}
        value={siteId ?? ''}
        onChange={(event) => changeSite(event.target.value)}
        options={[
          { value: '', label: t('wqSource.ui.allSites') },
          ...(sites.data?.items ?? []).map((site) => ({ value: site.id, label: site.name })),
        ]}
      />
      <Select
        label={t('wqSource.ui.pointType')}
        value={kind}
        onChange={(event) => {
          const next = kinds.find((candidate) => candidate === event.target.value);
          if (next !== undefined) changeKind(next);
        }}
        options={kinds.map((candidate) => ({
          value: candidate,
          label: t(`wqSource.ui.kind.${candidate}`),
        }))}
      />
      {kind !== 'site' && (
        <Select
          label={t(`wqSource.ui.kind.${kind}`)}
          value={value !== null && value.kind === kind ? value.id : ''}
          onChange={(event) =>
            onChange(event.target.value === '' ? null : { kind, id: event.target.value })
          }
          options={[{ value: '', label: t(`wqSource.ui.chooseKind.${kind}`) }, ...options]}
        />
      )}
    </div>
  );
};
