/**
 * ConsoleHeading — the console header's left block (README §7.4): the eyebrow
 * "Workspace · Area" over the page title.
 *
 * WHY the title is the h1: in the console the header names the page, so the
 * page's own heading row shows only its actions (README §4, phase 3). The
 * title clamps between 21px and 28px with the console column's width (`cqi`
 * resolves against the `page` container, `.sd-content`), keeps to two lines
 * and balances them. The eyebrow names the workspace once when the area is
 * the workspace itself (a module's home), and truncates rather than wrap.
 */
import type { ReactElement } from 'react';

import { useI18n } from '../../../i18n';

export interface ConsoleHeadingProps {
  /** The active workspace's label, localized ("Production"). */
  readonly workspaceLabel: string;
  /** The rail area the page belongs to, localized ("Operations"); omitted when the page has none. */
  readonly areaLabel?: string;
  /** The page title, localized. */
  readonly title: string;
}

export function ConsoleHeading({
  workspaceLabel,
  areaLabel,
  title,
}: ConsoleHeadingProps): ReactElement {
  const { t } = useI18n();
  const eyebrow =
    areaLabel === undefined || areaLabel === workspaceLabel
      ? workspaceLabel
      : t('console.header.eyebrow', { workspace: workspaceLabel, area: areaLabel });

  return (
    <div className="flex min-w-[180px] flex-[0_1_clamp(180px,22cqi,330px)] flex-col gap-1 @max-[821px]/page:flex-[1_1_auto]">
      <p className="m-0 flex items-center whitespace-nowrap text-[12.5px] font-bold uppercase tracking-[0.12em] text-sd-accent-700">
        <span className="truncate">{eyebrow}</span>
      </p>
      <h1 className="m-0 max-h-[2.1em] overflow-hidden text-balance font-display-sd text-[length:clamp(21px,1.4cqi_+_12px,28px)] font-semibold leading-[1.05] tracking-[-0.015em] text-sd-ink">
        {title}
      </h1>
    </div>
  );
}
