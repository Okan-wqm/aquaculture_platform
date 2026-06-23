import { MessageCircle } from 'lucide-react';
import type { ReactElement } from 'react';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * EmptyChat -- placeholder state for channels with no messages yet.
 *
 * WHY large centered icon: Mobile screens have limited space, but an empty
 * chat should communicate "nothing here yet, go ahead and type" quickly.
 * The muted colors and simple copy avoid alarming the user -- this is a
 * normal state, not an error.
 */
export function EmptyChat(): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center flex-1 px-8 py-16">
      {/* WHY: ocean-50 circle with ocean icon -- uses the primary brand color
          at low intensity to keep the empty state calm but on-brand. */}
      <div className="w-20 h-20 bg-ocean-50 dark:bg-ocean-950/40 rounded-full flex items-center justify-center mb-5">
        <MessageCircle size={36} className="text-ocean-400 dark:text-ocean-500" />
      </div>
      <h3 className="text-base font-bold text-gray-900 dark:text-white mb-1.5">
        Start the conversation
      </h3>
      <p className="text-sm text-gray-400 dark:text-gray-500 text-center leading-relaxed max-w-[240px]">
        Send your first message to get started
      </p>
    </div>
  );
}
