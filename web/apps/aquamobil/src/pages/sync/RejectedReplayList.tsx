/**
 * The replays the server rejected, listed for re-entry (PKG-42; ADR-051 C6).
 *
 * Each row names the operation, when it was recorded, why the server refused it and what the
 * worker entered, so they can enter it again where it still belongs; it leaves the device only
 * when they dismiss it. The decision of what counts as rejected, and the values shown, are
 * pwa/rejected-replays.ts's.
 */
import { useI18n } from '@aquaculture/shared-ui/i18n';
import { AlertCircle } from 'lucide-react';
import { useId, type JSX } from 'react';

import { Button, Card } from '@/components/ui';
import { recordedValues, rejectedReplayReason, rejectionCodeOf } from '@/pwa/rejected-replays';
import type { QueuedOperation } from '@/types';

export interface RejectedReplayListProps {
  readonly operations: readonly QueuedOperation[];
  readonly labelOf: (operation: QueuedOperation) => string;
  readonly formatDate: (iso: string) => string;
  readonly onDismiss: (id: string) => void;
}

export function RejectedReplayList({
  operations,
  labelOf,
  formatDate,
  onDismiss,
}: RejectedReplayListProps): JSX.Element | null {
  const { t } = useI18n();
  const headingId = useId();
  const rejected = operations.flatMap((operation) => {
    const code = rejectionCodeOf(operation);
    return code === null ? [] : [{ operation, code }];
  });
  if (rejected.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-body font-semibold text-crit px-1">
        {t('m.sync.rejected.title')}
      </h2>
      <p className="text-body text-ink-2 px-1">{t('m.sync.rejected.intro')}</p>
      {rejected.map(({ operation, code }) => (
        <Card key={operation.id} className="p-3 flex flex-col gap-2 border-crit">
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="text-crit shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-title font-medium text-ink-1">{labelOf(operation)}</div>
              <div className="text-meta text-ink-3">
                {t('m.sync.rejected.recordedAt', { time: formatDate(operation.createdAt) })}
              </div>
              <div className="text-body text-crit">{t(rejectedReplayReason(code))}</div>
            </div>
          </div>
          <dl
            aria-label={t('m.sync.rejected.entered')}
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-meta"
          >
            {recordedValues(operation.payload).map(({ field, value }) => (
              <div key={field} className="contents">
                <dt className="text-ink-3">{field}</dt>
                <dd className="text-ink-1 break-words">{value}</dd>
              </div>
            ))}
          </dl>
          <Button
            variant="secondary"
            onClick={() => {
              onDismiss(operation.id);
            }}
          >
            {t('m.sync.rejected.dismiss')}
          </Button>
        </Card>
      ))}
    </section>
  );
}
