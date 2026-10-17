/**
 * PreviewChip — the inline form of a preview (FE-MEDIUM-337).
 *
 * WHAT: the rendered value with a square MOCK chip beside it, for a single
 * number or cell (a workspace-menu alarm count, the title-block revision)
 * where a notice band would not fit.
 *
 * WHY a button: the chip has to be reachable by keyboard and touch, not only
 * by hover, so the reason and the finding are there for everyone. It is
 * described by a tooltip that is always in the DOM (`hidden` until hover,
 * focus or a press), so assistive technology reads the description on focus
 * whether or not it is showing. When it shows and hides is
 * usePreviewTooltip's (WCAG 1.4.13); where it opens is measured on open, so
 * neither the sticky header nor the viewport's edge cuts it off.
 *
 * The tooltip sits inside whatever cell hosts the chip — the title block's
 * condensed, unwrapped, tabular figures — so it resets the type it would
 * inherit and wraps the reason in body text. Its gap to the chip is padding
 * inside it, so the pointer can cross onto the tooltip without leaving it.
 *
 * Rendered by MockPreview only; it receives what the value rendered to, never
 * the value.
 */
import { useId, type ReactElement, type ReactNode } from 'react';

import { useI18n } from '../i18n';

import { PREVIEW_FACE_CLASS } from './PreviewFace';
import type { PreviewSource } from './previewData';
import type { PreviewTooltipPlacement } from './previewTooltipPlacement';
import { usePreviewTooltip } from './usePreviewTooltip';

export interface PreviewChipProps {
  readonly source: PreviewSource;
  readonly children: ReactNode;
}

/** Box and type of the tooltip, reset from whatever the host cell sets. */
const TOOLTIP_CLASS =
  'absolute z-50 w-max max-w-[min(18rem,calc(100vw-32px))] whitespace-normal text-left font-body-sd text-xs font-normal normal-case leading-snug tracking-normal normal-nums text-sd-ink';

/** The gap to the chip is padding on the chip's side: the hover bridge. */
const SIDE_CLASS: Readonly<Record<PreviewTooltipPlacement['side'], string>> = {
  top: 'bottom-full pb-1.5',
  bottom: 'top-full pt-1.5',
};

const ALIGN_CLASS: Readonly<Record<PreviewTooltipPlacement['align'], string>> = {
  start: 'left-0',
  center: 'left-1/2 -translate-x-1/2',
  end: 'right-0',
};

export function PreviewChip({ source, children }: PreviewChipProps): ReactElement {
  const { t } = useI18n();
  const tooltipId = useId();
  const { open, placement, rootRef, tooltipRef, rootProps, triggerProps } = usePreviewTooltip();

  return (
    <span className="inline-flex items-center gap-1.5" data-preview-finding={source.finding}>
      {children}
      <span ref={rootRef} className="relative inline-flex" {...rootProps}>
        <button
          type="button"
          aria-describedby={tooltipId}
          className={`${PREVIEW_FACE_CLASS} cursor-help focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sd-accent`}
          {...triggerProps}
        >
          {t('preview.chipLabel')}
        </button>
        <span
          ref={tooltipRef}
          role="tooltip"
          id={tooltipId}
          hidden={!open}
          data-side={placement.side}
          data-align={placement.align}
          className={`${TOOLTIP_CLASS} ${SIDE_CLASS[placement.side]} ${ALIGN_CLASS[placement.align]}`}
        >
          <span className="block border border-sd-hz-amber bg-sd-hz-amber-tint px-2.5 py-1.5 shadow-(--shadow-sd-md)">
            <span className="block font-bold uppercase tracking-[0.12em] text-sd-hz-amber-ink">
              {t('preview.eyebrow')}
            </span>{' '}
            <span className="block">{t(source.reasonKey)}</span>{' '}
            <span className="block font-mono">{t('preview.finding', { id: source.finding })}</span>{' '}
            <span className="block text-sd-ink-muted">{t('preview.sampleData')}</span>
          </span>
        </span>
      </span>
    </span>
  );
}
