import React from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SystemMessageProps {
  /** The system event text, e.g. "John joined the channel". */
  text: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * SystemMessage -- centered, italic event message with no bubble or avatar.
 *
 * WHY React.memo: System messages are static once rendered -- their text
 * never changes. Memoising prevents re-rendering when surrounding chat
 * messages update.
 */
export const SystemMessage = React.memo(function SystemMessage({ text }: SystemMessageProps) {
  return (
    <div className="flex justify-center py-1.5 px-4" role="status">
      <span className="text-meta text-ink-3 italic font-medium text-center">{text}</span>
    </div>
  );
});
