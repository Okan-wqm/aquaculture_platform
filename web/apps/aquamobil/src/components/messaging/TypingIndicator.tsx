import { clsx } from 'clsx';
import type { ReactElement } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TypingIndicatorProps {
  /** Names of users currently typing. */
  typingUsers: string[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * TypingIndicator -- animated three-dot indicator with user names.
 *
 * WHY CSS keyframes via Tailwind arbitrary: Keeps the bounce animation
 * co-located with the component instead of requiring a global stylesheet
 * entry. The staggered delays create the classic wave effect.
 *
 * WHY max 3 names: Showing more than 3 names overflows the single-line
 * layout on narrow mobile screens. "3 people are typing..." is sufficient.
 */
export function TypingIndicator({ typingUsers }: TypingIndicatorProps): ReactElement | null {
  if (typingUsers.length === 0) return null;

  let label: string;
  if (typingUsers.length === 1) {
    label = `${typingUsers[0]} is typing`;
  } else if (typingUsers.length === 2) {
    label = `${typingUsers[0]}, ${typingUsers[1]} are typing`;
  } else if (typingUsers.length === 3) {
    label = `${typingUsers[0]}, ${typingUsers[1]}, ${typingUsers[2]} are typing`;
  } else {
    label = `${typingUsers.length} people are typing`;
  }

  return (
    <div
      // `animate-am-fade` is the v4 motion layer's 200ms entrance. It replaces
      // an arbitrary fade whose @keyframes lived in AttachmentPicker's inline
      // <style> — so the animation only ran when an unrelated component happened
      // to be mounted. The token animation is always defined and stops under
      // prefers-reduced-motion.
      className={clsx('flex items-center gap-2 px-4 py-2', 'animate-am-fade')}
      aria-live="polite"
      aria-label={label}
    >
      {/* Three bouncing dots */}
      <div className="flex items-center gap-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-ink-3 animate-bounce [animation-delay:0ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-ink-3 animate-bounce [animation-delay:150ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-ink-3 animate-bounce [animation-delay:300ms]" />
      </div>
      <span className="text-meta text-ink-3 font-medium truncate">{label}...</span>
    </div>
  );
}
