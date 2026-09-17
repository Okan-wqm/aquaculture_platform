import { MessageCircle } from 'lucide-react';
import type { ReactElement } from 'react';

import { EmptyState } from '@/components/ui';

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
 *
 * WHY the kit's EmptyState rather than the hand-rolled block this replaces:
 * the kit draws "nothing here" and "could not load" differently (`tone`), which
 * is exactly the distinction the WHY above is asking for. `tone` stays at its
 * `empty` default here — an empty channel is good news, not a failure.
 * `flex-1` is kept because the chat column expects this to fill the scroller.
 */
export function EmptyChat(): ReactElement {
  return (
    <EmptyState
      className="flex-1 justify-center"
      icon={<MessageCircle size={22} />}
      title="Start the conversation"
      description="Send your first message to get started"
    />
  );
}
