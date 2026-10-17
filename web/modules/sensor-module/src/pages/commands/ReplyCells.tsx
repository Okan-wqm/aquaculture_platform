/**
 * How the command log marks a command that did not take effect.
 *
 * Industry colour rule (handoff README §7.8): colour only for the abnormal.
 * A failed, rejected, timed-out or expired command gets the amber flag bar on
 * its row's leading edge and an amber triangle beside its outcome; the
 * outcome is always written out, so the colour is never the only signal.
 */
import React from 'react';
import { useI18n } from '@aquaculture/shared-ui';

/**
 * The flagged row's 5px amber bar (DataTable `rowClassName`), drawn on the
 * row's first cell: a box shadow on a table row (`tr`) is not painted
 * reliably across engines (WebKit drops it under preflight's
 * `border-collapse: collapse`), on a cell (`td`) it is — as farm finance's
 * SEVERITY_ROW does.
 */
export const FAILED_ROW = '[&>td:first-child]:shadow-[inset_5px_0_0_var(--color-sd-hz-amber)]';

/** The amber warning triangle, decorative: the words beside it carry the meaning. */
export function AmberGlyph(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2.5 w-3 shrink-0 bg-sd-hz-amber [clip-path:polygon(50%_0,100%_100%,0_100%)]"
    />
  );
}

/** An outcome that did not take effect, in amber ink, with what the device said. */
export function FlaggedOutcome({
  label,
  detail,
}: {
  label: string;
  detail: string | null;
}): React.JSX.Element {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1.5 font-semibold text-sd-hz-amber-ink">
        <AmberGlyph />
        <span>{label}</span>
      </span>
      {detail !== null && detail !== '' ? (
        <span className="text-xs text-gray-700 dark:text-gray-300">{detail}</span>
      ) : null}
    </span>
  );
}

/** A drive command the drive did not accept, with its error. */
export function ReplyFailed({ error }: { error: string | null }): React.JSX.Element {
  const { t } = useI18n();
  return <FlaggedOutcome label={t('sensorCommands.reply.failed')} detail={error} />;
}
