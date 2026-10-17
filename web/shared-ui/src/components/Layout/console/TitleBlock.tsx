/**
 * TitleBlock — the drawing sheet's title block ("pafta") in the console
 * header (README §7.4).
 *
 * WHAT: a row of key/value cells on a 1px rule grid — live sites, devices,
 * the sheet code and the revision. The live counts show from a console width
 * of 1180px, the sheet code and the revision join them from 1340px (`page`
 * container queries, so the rail's width counts).
 *
 * WHY two widths: the header row shrinks only its heading (to 180px) and its
 * palette trigger (to 200px); the title block, the tools frame and the user
 * menu keep their width. The design's single 1180px breakpoint comes from a
 * prototype with no tools frame and no MOCK chip on the revision, and there
 * all four cells pushed the row past the console column (Chromium, Turkish,
 * a long name: 65px at 1180px, 10px at 1240px). With the user menu's name
 * capped at 180px, the two counts fit from 1180px and all four from 1340px
 * in both locales.
 *
 * WHY a cell can be missing: the repo's rule is that a value without a
 * source is not drawn (README §3). The counts come from the shell's
 * tenant-scoped queries and draw only while 'ready' — loading, failed or not
 * for this viewer leaves no cell, never a zero nobody measured. The sheet code
 * is derived from the nav ids (`deriveSheetCode`), and the revision has no
 * source at all yet: the shell passes it as a labelled preview cell
 * (MockPreview, FE-LOW-338), never as a plain value. With no cell, nothing
 * renders.
 *
 * Semantics: a description list inside a group named "Title block" — a role
 * on the <dl> itself would replace its list semantics and orphan every term
 * and definition. Each ratio is shown as "2 / 3" and spoken as "2 of 3 sites
 * live". A cell hidden at the current width is hidden from everyone.
 */
import type { ReactElement, ReactNode } from 'react';

import { useI18n } from '../../../i18n';

import type { ConsoleDeviceCounts, ConsoleSiteCounts } from './headerTypes';

export interface TitleBlockProps {
  /** Live sites out of active sites — the shell's useSiteStatus() result. */
  readonly sites: ConsoleSiteCounts;
  /** Devices online out of all — the shell's useDeviceStatus() result. */
  readonly devices: ConsoleDeviceCounts;
  /** The page's sheet code (`deriveSheetCode`), or null when the page has none. */
  readonly sheetCode: string | null;
  /** The revision cell's content; the shell passes its MockPreview (FE-LOW-338). */
  readonly revision?: ReactNode;
}

/** `status`: the live counts, from 1180px. `sheet`: the sheet code and revision, from 1340px. */
type CellTier = 'status' | 'sheet';

interface Cell {
  readonly id: string;
  readonly tier: CellTier;
  readonly term: string;
  readonly value: ReactNode;
}

const CELL_SHOWN_FROM: Readonly<Record<CellTier, string>> = {
  status: 'flex',
  sheet: 'hidden @min-[1340px]/page:flex',
};

/** The block shows from the narrowest width at which one of its cells shows. */
const BLOCK_SHOWN_FROM: Readonly<Record<CellTier, string>> = {
  status: 'hidden @min-[1180px]/page:block',
  sheet: 'hidden @min-[1340px]/page:block',
};

function Ratio({
  value,
  total,
  spoken,
}: {
  value: number;
  total: number;
  spoken: string;
}): ReactElement {
  const { t } = useI18n();
  return (
    <>
      <span aria-hidden="true">{t('console.titleBlock.ratio', { value, total })}</span>
      <span className="sr-only">{spoken}</span>
    </>
  );
}

export function TitleBlock({
  sites,
  devices,
  sheetCode,
  revision,
}: TitleBlockProps): ReactElement | null {
  const { t } = useI18n();
  const cells: Cell[] = [];

  if (sites.status === 'ready') {
    cells.push({
      id: 'sites',
      tier: 'status',
      term: t('console.titleBlock.liveSites'),
      value: (
        <Ratio
          value={sites.live}
          total={sites.total}
          spoken={t('console.titleBlock.liveSitesSpoken', {
            value: sites.live,
            total: sites.total,
          })}
        />
      ),
    });
  }
  if (devices.status === 'ready') {
    cells.push({
      id: 'devices',
      tier: 'status',
      term: t('console.titleBlock.devices'),
      value: (
        <Ratio
          value={devices.online}
          total={devices.total}
          spoken={t('console.titleBlock.devicesSpoken', {
            value: devices.online,
            total: devices.total,
          })}
        />
      ),
    });
  }
  if (sheetCode !== null) {
    cells.push({
      id: 'sheet',
      tier: 'sheet',
      term: t('console.titleBlock.sheet'),
      value: sheetCode,
    });
  }
  if (revision !== undefined) {
    cells.push({
      id: 'revision',
      tier: 'sheet',
      term: t('console.titleBlock.revision'),
      value: revision,
    });
  }

  if (cells.length === 0) return null;
  const blockTier: CellTier = cells.some((cell) => cell.tier === 'status') ? 'status' : 'sheet';

  return (
    <div
      role="group"
      aria-label={t('console.titleBlock.label')}
      className={`shrink-0 ${BLOCK_SHOWN_FROM[blockTier]}`}
    >
      <dl className="m-0 grid grid-flow-col gap-px border border-sd-rule bg-sd-rule">
        {cells.map((cell) => (
          <div
            key={cell.id}
            className={`${CELL_SHOWN_FROM[cell.tier]} min-w-[84px] flex-col gap-[3px] bg-sd-paper px-3.5 py-[7px]`}
          >
            <dt className="whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.12em] text-sd-neutral-700">
              {cell.term}
            </dt>
            <dd className="m-0 whitespace-nowrap font-display-sd text-[17px] font-semibold leading-none tabular-nums text-sd-ink">
              {cell.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
