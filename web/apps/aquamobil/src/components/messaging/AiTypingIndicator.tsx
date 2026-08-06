/**
 * AiTypingIndicator -- AI-specific typing/thinking indicator.
 *
 * WHY separate from TypingIndicator: The AI thinking state is more prominent
 * and centered, with a brain/sparkle icon instead of generic dots, to signal
 * that an AI (not a human) is processing the request.
 */

import { clsx } from 'clsx';
import { Brain } from 'lucide-react';
import type { ReactElement } from 'react';

interface AiTypingIndicatorProps {
  /** Whether to show the indicator. */
  visible: boolean;
  /** If true, show a "taking longer" message after timeout. */
  isDelayed?: boolean;
}

/**
 * AiTypingIndicator renders an animated brain icon with "AI is thinking..."
 * text. When `isDelayed` is true, it shows a fallback message.
 */
export function AiTypingIndicator({
  visible,
  isDelayed = false,
}: AiTypingIndicatorProps): ReactElement | null {
  if (!visible) return null;

  return (
    <div
      // See TypingIndicator: the pre-v4 arbitrary fade animation depended on
      // @keyframes that AttachmentPicker injected in an inline <style>, so it
      // silently did nothing unless that component happened to be mounted.
      className={clsx(
        'flex flex-col items-center justify-center gap-2 py-4 px-6',
        'animate-am-fade',
      )}
      aria-live="polite"
      aria-label={isDelayed ? 'AI is taking longer than expected' : 'AI is thinking'}
    >
      {/* WHY the accent rather than the violet this replaces: v4 gives the
          accent every active state and there is no AI token — a hand-picked
          purple would be the one colour in the app no theme owns. The brain
          icon and the copy are what say "an AI, not a person". */}
      <div className="flex items-center gap-2">
        <Brain size={20} className="text-acc animate-pulse" />
        <span className="text-body text-acc font-medium">
          {isDelayed ? 'AI is taking longer than expected...' : 'AI is thinking...'}
        </span>
        <div className="flex items-center gap-0.5">
          <span className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-acc animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
