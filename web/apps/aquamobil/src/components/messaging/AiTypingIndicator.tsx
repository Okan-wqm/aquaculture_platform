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
export function AiTypingIndicator({ visible, isDelayed = false }: AiTypingIndicatorProps): ReactElement | null {
  if (!visible) return null;

  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center gap-2 py-4 px-6',
        'animate-[fadeIn_200ms_ease-in-out]',
      )}
      aria-live="polite"
      aria-label={isDelayed ? 'AI is taking longer than expected' : 'AI is thinking'}
    >
      <div className="flex items-center gap-2">
        <Brain
          size={20}
          className="text-purple-500 animate-pulse"
        />
        <span className="text-sm text-purple-500 font-medium">
          {isDelayed ? 'AI is taking longer than expected...' : 'AI is thinking...'}
        </span>
        <div className="flex items-center gap-0.5">
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce [animation-delay:0ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-bounce [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
