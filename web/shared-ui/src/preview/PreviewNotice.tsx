/**
 * PreviewNotice — the block form of a preview (FE-MEDIUM-337).
 *
 * WHAT: a hazard-amber notice band above the section it labels — the
 * hazard stripe on its edge, the MOCK face, the eyebrow "PREVIEW · NO BACKEND
 * YET", the reason, the tracked finding and "data shown is sample data" —
 * and the section framed with it, so the frame shows how far the sample data
 * reaches.
 *
 * WHY: the band is `role="note"` and comes first in reading order, and the
 * section is a group described by it, so a screen reader that lands inside
 * the section still hears that its figures are sample data. Industry tokens
 * only: the amber tint, ink and stripe flip with the theme in theme.css.
 *
 * Rendered by MockPreview only; it receives what the value rendered to, never
 * the value.
 */
import { useId, type ReactElement, type ReactNode } from 'react';

import { useI18n } from '../i18n';

import { PreviewFace } from './PreviewFace';
import type { PreviewSource } from './previewData';

export interface PreviewNoticeProps {
  readonly source: PreviewSource;
  readonly children: ReactNode;
}

export function PreviewNotice({ source, children }: PreviewNoticeProps): ReactElement {
  const { t } = useI18n();
  const id = useId();
  const noticeId = `${id}-notice`;
  const eyebrowId = `${id}-eyebrow`;

  return (
    <div className="border border-sd-hz-amber" data-preview-finding={source.finding}>
      <div
        role="note"
        id={noticeId}
        aria-labelledby={eyebrowId}
        className="relative border-b border-sd-hz-amber bg-sd-hz-amber-tint py-2.5 pl-5 pr-4 text-sd-ink"
      >
        {/* The hazard stripe: amber and ink at 45°, the Industry marker for "not live". */}
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-2 bg-[image:repeating-linear-gradient(-45deg,var(--color-sd-hz-amber)_0_5px,var(--color-sd-hz-on-amber)_5px_10px)]"
        />
        <p className="flex flex-wrap items-center gap-2">
          <PreviewFace />
          <span
            id={eyebrowId}
            className="text-[12.5px] font-bold uppercase tracking-[0.12em] text-sd-hz-amber-ink"
          >
            {t('preview.eyebrow')}
          </span>
        </p>
        <p className="mt-1 text-[13.5px] leading-snug">{t(source.reasonKey)}</p>
        <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-sd-ink-muted">
          <span className="font-mono">{t('preview.finding', { id: source.finding })}</span>
          <span>{t('preview.sampleData')}</span>
        </p>
      </div>
      <div role="group" aria-describedby={noticeId}>
        {children}
      </div>
    </div>
  );
}
