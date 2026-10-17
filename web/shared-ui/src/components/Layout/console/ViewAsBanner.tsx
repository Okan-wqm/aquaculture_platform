/**
 * ViewAsBanner — the band at the top of the page while an admin previews the
 * console as another role (README §8; decision D19: shown whenever the role
 * being viewed is not the user's own).
 *
 * WHAT: an accent-100 band in a 1px accent frame naming the role, a line
 * saying that changes still run with the user's own role (the preview filters
 * the rail and pages client-side only), and the way back. The shell renders it
 * as the first child of <main> on every render, with `roleLabel` null while
 * the user's own role shows — then only an empty, unframed status is drawn.
 *
 * WHY always mounted: the message is a live region, and screen readers
 * announce a change inside a region already in the document, not a region
 * inserted with its content. So the status stays in the DOM, empty, and the
 * first switch into a role view fills the same node and is announced without
 * moving focus. The exit button sits beside the status, not inside it, so the
 * announcement is the message alone.
 */
import type { ReactElement } from 'react';

import { useI18n } from '../../../i18n';
import { Button } from '../../Button';

export interface ViewAsBannerProps {
  /** The label of the role being viewed, or null while the user's own role shows. */
  readonly roleLabel: string | null;
  /** Back to the user's own view. */
  readonly onExit: () => void;
}

const BAND_CLASS =
  'flex flex-wrap items-center gap-[13.6px] border border-sd-accent bg-sd-accent-100 px-[20.4px] py-2.5 text-sd-accent-900';

export function ViewAsBanner({ roleLabel, onExit }: ViewAsBannerProps): ReactElement {
  const { t } = useI18n();
  return (
    <div className={roleLabel === null ? undefined : BAND_CLASS}>
      <p role="status" className="m-0 flex-[1_1_320px]">
        {roleLabel !== null && (
          <>
            <span className="block text-[15.5px] font-medium">
              {t('console.viewAs.banner', { role: roleLabel })}
            </span>
            <span className="block text-[13.5px]">{t('console.viewAs.note')}</span>
          </>
        )}
      </p>
      {roleLabel !== null && (
        <Button variant="secondary" onClick={onExit}>
          {t('console.viewAs.exit')}
        </Button>
      )}
    </div>
  );
}
