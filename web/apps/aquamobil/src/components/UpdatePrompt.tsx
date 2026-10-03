import { RefreshCw, X } from 'lucide-react';
import { useSyncExternalStore, type ReactElement } from 'react';

import { Button, Card, IconButton } from '@/components/ui';
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
      className="fixed bottom-nav-gap left-4 right-4 z-50 animate-am-up"
      role="status"
      aria-live="polite"
    >
      <Card className="p-4">
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 bg-acc-dim rounded-xl flex items-center justify-center flex-shrink-0">
            <RefreshCw size={24} className="text-acc" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-title font-semibold text-ink-1">New version available</h3>
            <p className="text-meta text-ink-3 mt-1">
              Reload to update. Unsent records stay queued on this device.
            </p>
          </div>
          <IconButton
            onClick={dismissUpdate}
            aria-label="Dismiss update notice"
            className="-mr-2 -mt-2 flex-shrink-0"
          >
            <X size={18} className="text-ink-3" />
          </IconButton>
        </div>
        <Button variant="primary" block onClick={apply} className="mt-3">
          <RefreshCw size={16} />
          Reload now
        </Button>
      </Card>
    </div>
  );
}
