import { clsx } from 'clsx';
import { Clock, Check, CheckCheck } from 'lucide-react';
import React from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read';

interface ReadReceiptProps {
  /** Current delivery/read status of the message. */
  status: DeliveryStatus;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * ReadReceipt -- WhatsApp-style delivery status icons.
 *
 * WHY React.memo: This is a pure presentational component rendered inside
 * every own-message bubble. Memoising avoids re-rendering hundreds of
 * receipt icons when the message list scrolls or a single message updates.
 */
export const ReadReceipt = React.memo(function ReadReceipt({ status }: ReadReceiptProps) {
  switch (status) {
    case 'pending':
      return <Clock size={12} className="text-gray-400 shrink-0" aria-label="Sending" />;
    case 'sent':
      return <Check size={12} className="text-gray-400 shrink-0" aria-label="Sent" />;
    case 'delivered':
      return <CheckCheck size={12} className="text-gray-400 shrink-0" aria-label="Delivered" />;
    case 'read':
      return <CheckCheck size={12} className={clsx('text-ocean-600 shrink-0')} aria-label="Read" />;
  }
});
