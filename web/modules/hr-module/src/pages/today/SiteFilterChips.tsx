/**
 * Site filter for the Today page: "All sites", then every active site.
 *
 * The sites are farm-service's active sites (the same read that feeds the
 * unassigned-sites panel); a chosen site narrows the plan on the server
 * (teamWeeklyOverview's siteId matches employees.farmId). Chips are toggle
 * buttons — `aria-pressed` carries the choice — at the design's 44 px target.
 */
import React from 'react';
import { Button, useI18n } from '@aquaculture/shared-ui';

export interface SiteFilterOption {
  id: string;
  name: string;
}

export interface SiteFilterChipsProps {
  sites: readonly SiteFilterOption[];
  selected: string | undefined;
  onSelect: (siteId: string | undefined) => void;
}

export function SiteFilterChips({
  sites,
  selected,
  onSelect,
}: SiteFilterChipsProps): React.JSX.Element {
  const { t } = useI18n();
  const chips: Array<{ id: string | undefined; label: string }> = [
    { id: undefined, label: t('hr.today.sites.all') },
    ...sites.map((site) => ({ id: site.id, label: site.name })),
  ];

  return (
    <div
      role="group"
      aria-label={t('hr.today.sites.filterLabel')}
      className="flex flex-wrap gap-1.5"
    >
      {chips.map(({ id, label }) => {
        const pressed = id === selected;
        return (
          <Button
            key={id ?? 'all'}
            size="lg"
            variant={pressed ? 'primary' : 'secondary'}
            aria-pressed={pressed}
            onClick={() => onSelect(id)}
            className="whitespace-nowrap"
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}
