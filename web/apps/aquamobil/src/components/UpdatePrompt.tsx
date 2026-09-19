import { RefreshCw, X } from 'lucide-react';
import { useSyncExternalStore, type ReactElement } from 'react';

import { dismissUpdate, getUpdateSnapshot, subscribeUpdate } from '@/pwa/update-available';

/**
 * "New version available" banner. Same surface and placement as
 * `InstallPrompt`; replaces the blocking `confirm()` the service-worker
 * registration used to open from outside React.
 */
export function UpdatePrompt(): ReactElement | null {
  const { available, apply } = useSyncExternalStore(
    subscribeUpdate,
    getUpdateSnapshot,
    getUpdateSnapshot,
  );

  if (!available || !apply) return null;

  return (
    <div
      className="fixed bottom-nav-gap left-4 right-4 z-50 animate-slide-up"
      role="status"
      aria-live="polite"
    >
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-elevated border border-gray-100 dark:border-gray-800 p-4">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 bg-ocean-50 dark:bg-ocean-900/20 rounded-xl flex items-center justify-center flex-shrink-0">
            <RefreshCw size={24} className="text-ocean-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-gray-900 dark:text-white text-sm">
              New version available
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Reload to update. Unsent records stay queued on this device.
            </p>
          </div>
          <button
            type="button"
            onClick={dismissUpdate}
            aria-label="Dismiss update notice"
            className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 flex-shrink-0"
          >
            <X size={18} />
          </button>
        </div>
        <button
          type="button"
          onClick={apply}
          className="w-full mt-3 min-h-[44px] py-2.5 bg-ocean-600 hover:bg-ocean-700 text-white font-semibold rounded-xl text-sm flex items-center justify-center gap-2 touch-feedback transition-colors"
        >
          <RefreshCw size={16} />
          Reload now
        </button>
      </div>
    </div>
  );
}
