import { AlertCircle } from 'lucide-react';
import type { JSX } from 'react';

/**
 * FE-HIGH-050: a deduped double-tap is NOT a fresh record. When `addToQueue`
 * collapses a submission onto an operation already in the queue, the success
 * screen renders this instead of the queued badge, so the operator is not led
 * to believe a second entry was created. Shared by every queue-first write
 * page (RecordEntityPage and the water-quality / storage / feeding pages).
 */
export function AlreadyRecordedNotice(): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="w-20 h-20 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center">
        <AlertCircle size={48} className="text-amber-600" />
      </div>
      <h2 className="text-xl font-bold text-amber-700 dark:text-amber-300">Already recorded</h2>
      <p className="text-sm text-amber-600 dark:text-amber-400">
        This entry was already submitted moments ago -- no duplicate was created.
      </p>
    </div>
  );
}
