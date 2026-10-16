/**
 * RailDeviceBand — "11 of 12 devices online" at the foot of the rail
 * (digest §5, README §7.2).
 *
 * WHAT: a dashed neutral square (the console marks "fine" without colour,
 * README §7.8) and the count — the sentence while expanded, `11/12` in the
 * icon column with the sentence kept for assistive technology and the tooltip.
 *
 * WHY nothing outside `ready`: the band states a measured fact. While the
 * count loads, after its query fails, or for a viewer without device access,
 * there is no fact to state, so the band is not drawn (never a made-up zero).
 */
import type { ReactElement } from 'react';

import { useI18n } from '../../../i18n';

import type { ConsoleDeviceCounts } from './headerTypes';

export interface RailDeviceBandProps {
  readonly devices: ConsoleDeviceCounts | undefined;
  readonly collapsed: boolean;
}

export function RailDeviceBand({ devices, collapsed }: RailDeviceBandProps): ReactElement | null {
  const { t } = useI18n();
  if (devices === undefined || devices.status !== 'ready') return null;

  const counts = { online: devices.online, total: devices.total };
  const sentence = t(
    devices.total === 1 ? 'console.rail.devicesOnline.one' : 'console.rail.devicesOnline.other',
    counts,
  );

  return (
    <div
      title={collapsed ? sentence : undefined}
      className={`flex shrink-0 items-center gap-2.5 border-t border-sd-rule p-3.5 text-sm text-sd-neutral-800 tabular-nums ${
        collapsed ? 'justify-center' : ''
      }`}
    >
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 border-[1.5px] border-dashed border-sd-neutral-600"
      />
      {collapsed ? (
        <>
          <span aria-hidden="true">{t('console.rail.devicesOnline.short', counts)}</span>
          <span className="sr-only">{sentence}</span>
        </>
      ) : (
        <span>{sentence}</span>
      )}
    </div>
  );
}
