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
  /**
   * Colour scheme. The names are the pre-v4 vocabulary and are kept because
   * they are part of the public prop contract; `blue` now resolves to the v4
   * accent and `red` to the alarm token, so both track the active theme.
   */
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
        // text-meta is 12px, the sunlight floor. It replaces a 10px arbitrary
        // size: an unread count is one of the first things read at arm's length.
        size === 'sm' && 'min-w-[16px] h-4 text-meta px-1',
        size === 'md' && 'min-w-[20px] h-5 text-meta px-1.5',
        // `text-acc-on` is the ink the theme puts on a saturated fill; on the
        // night coral a hardcoded white would fail contrast.
        color === 'red' && 'bg-crit text-acc-on',
        color === 'blue' && 'bg-acc text-acc-on',
      )}
      aria-label={`${count} unread`}
    >
      {label}
    </span>
  );
});
