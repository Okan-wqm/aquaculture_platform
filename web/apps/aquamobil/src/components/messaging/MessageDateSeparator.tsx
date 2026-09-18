import React from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MessageDateSeparatorProps {
  /** ISO date string or display label ("Today", "Yesterday", etc.). */
  date: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * WHY: Formats an ISO date into a human-friendly label. "Today" and
 * "Yesterday" are the most common cases for active messaging -- field
 * workers almost never scroll past a few days of history.
 */
function formatDateLabel(dateStr: string): string {
  // Allow pre-formatted labels to pass through
  if (['Today', 'Yesterday'].includes(dateStr)) return dateStr;

  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return dateStr;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffMs = today.getTime() - target.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * MessageDateSeparator -- centered pill divider between message date groups.
 *
 * WHY React.memo: Date separators are static content that never changes
 * once rendered. Memoising avoids wasted re-renders when scrolling.
 */
export const MessageDateSeparator = React.memo(function MessageDateSeparator({
  date,
}: MessageDateSeparatorProps) {
  const label = formatDateLabel(date);

  return (
    <div className="flex justify-center py-3 px-4 sticky top-0 z-10">
      <span className="text-[11px] font-semibold text-gray-500 dark:text-gray-400 bg-gray-200/80 dark:bg-gray-700/80 backdrop-blur-sm px-3 py-1 rounded-full">
        {label}
      </span>
    </div>
  );
});
