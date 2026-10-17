/**
 * One dashboard cell drawn from its source's state (model/cell): the value
 * when ready, a placeholder bar while loading, and a dash with its reason
 * spoken when the source failed — never a value nobody measured.
 */
import { useI18n } from '@aquaculture/shared-ui';
import type { ReactElement, ReactNode } from 'react';

import type { Cell } from '../model/cell';

export function CellValue<T>({
  cell,
  children,
}: {
  readonly cell: Cell<T>;
  readonly children: (value: T) => ReactNode;
}): ReactElement {
  const { t } = useI18n();
  if (cell.status === 'loading') {
    return (
      <span aria-hidden="true" className="inline-block h-4 w-16 animate-pulse bg-sd-neutral-200" />
    );
  }
  if (cell.status === 'error') {
    return (
      <span className="text-sd-neutral-600">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t('dashboard.sites.cellError')}</span>
      </span>
    );
  }
  return <>{children(cell.value)}</>;
}
