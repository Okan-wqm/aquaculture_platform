/**
 * @module UnreadBadge
 * @description Compact pill badge displaying unread message count. Memoized
 * with React.memo. Caps at "99+" for display consistency.
 * @see ADR-012 section 5 (Messaging UI Components)
 */

import { clsx } from 'clsx';
import React from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UnreadBadgeProps {
  /** Number of unread messages. */
  count: number;
  /** Badge size variant. */
  size?: 'sm' | 'md';
  /** Color scheme. */
  color?: 'red' | 'blue';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * UnreadBadge -- reusable pill that displays an unread message count.
 *
 * WHY React.memo: The badge is a pure component that only depends on its
 * props. Memoising prevents unnecessary re-renders when parent lists update
 * but this specific count has not changed.
 *
 * WHY "99+" cap: Three-digit numbers break the circular shape on small
 * badges and are meaningless in practice -- anything above 99 means
 * "a lot of unread messages" to a field worker.
 */
export const UnreadBadge = React.memo(function UnreadBadge({
  count,
  size = 'md',
  color = 'blue',
}: UnreadBadgeProps) {
  if (count <= 0) return null;

  const label = count > 99 ? '99+' : String(count);

  return (
    <span
      className={clsx(
        'inline-flex items-center justify-center font-bold rounded-full tabular-nums leading-none',
        size === 'sm' && 'min-w-[16px] h-4 text-[9px] px-1',
        size === 'md' && 'min-w-[20px] h-5 text-[10px] px-1.5',
        color === 'red' && 'bg-red-500 text-white',
        color === 'blue' && 'bg-ocean-600 text-white',
      )}
      aria-label={`${count} unread`}
    >
      {label}
    </span>
  );
});
